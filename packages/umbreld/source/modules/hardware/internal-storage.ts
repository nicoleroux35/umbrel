import fse from 'fs-extra'
import nodePath from 'node:path'

import {$} from 'execa'

import type Umbreld from '../../index.js'
import {getSystemDiskNames} from '../system/system-disk.js'
import {getRoundedDeviceSize} from './raid.js'

export {resolveSystemDiskNames} from '../system/system-disk.js'

function kelvinToCelsius(kelvin: number): number {
	return kelvin - 273
}

// Transports of disks we can manage as internal storage. SAS covers both SAS
// HDDs and SAS SSDs attached to a host bus adapter.
export const SUPPORTED_INTERNAL_TRANSPORTS = ['nvme', 'sata', 'sas'] as const
export type StorageTransport = (typeof SUPPORTED_INTERNAL_TRANSPORTS)[number]
export type HddTransport = Exclude<StorageTransport, 'nvme'>

// SAS and hardware RAID host bus adapter drivers. lsblk can't always label a
// disk's transport: virtual drives behind a RAID-mode controller (e.g. a
// MegaRAID card) report no transport at all, so a disk is also treated as
// internal SAS storage when it sits behind one of these adapters.
export const SAS_CONTROLLER_DRIVERS = new Set([
	'megaraid_sas',
	'megaraid',
	'mpt3sas',
	'mpt2sas',
	'mptsas',
	'aacraid',
	'hpsa',
	'isci',
	'pm80xx',
	'mvsas',
	'mvumi',
	'smartpqi',
])

export function isSupportedInternalTransport(tran: string | null | undefined): tran is StorageTransport {
	return tran !== null && tran !== undefined && (SUPPORTED_INTERNAL_TRANSPORTS as readonly string[]).includes(tran)
}

export function isSasControllerDriver(driver: string | null | undefined): boolean {
	return !!driver && SAS_CONTROLLER_DRIVERS.has(driver.trim().toLowerCase())
}

// Resolve how a disk is attached, or undefined when it isn't internal storage.
// An unlabelled disk on a SAS/RAID adapter is SAS by definition.
export function resolveStorageTransport({
	tran,
	hostDriver,
}: {
	tran?: string | null
	hostDriver?: string | null
}): StorageTransport | undefined {
	if (isSupportedInternalTransport(tran)) return tran
	if (isSasControllerDriver(hostDriver)) return 'sas'
	return undefined
}

// Fallback name for disks that report no model, e.g. some SAS enclosures.
export function getDefaultStorageDeviceName(transport: StorageTransport): string {
	if (transport === 'nvme') return 'Unknown NVMe Device'
	if (transport === 'sas') return 'Unknown SAS Device'
	return 'Unknown SATA Device'
}

type SmartLike = {
	temperature?: {current?: number}
	smart_status?: {passed?: boolean}
	nvme_smart_health_information_log?: {percentage_used?: number}
	scsi_percentage_used_endurance_indicator?: number
}

// Endurance used by SSDs. NVMe reports it in its SMART health log, SAS/SCSI
// SSDs in the Solid State Media log page.
export function getSmartLifetimeUsed(data: SmartLike): number | undefined {
	const nvmeUsed = data.nvme_smart_health_information_log?.percentage_used
	if (typeof nvmeUsed === 'number') return nvmeUsed
	const scsiUsed = data.scsi_percentage_used_endurance_indicator
	if (typeof scsiUsed === 'number') return scsiUsed
	return undefined
}

export type SsdDevice = {
	type: 'ssd'
	transport: StorageTransport
	device: string
	id?: string
	pciSlotNumber?: number
	slot?: number
	name: string
	model: string
	serial: string
	size: number
	roundedSize: number
	temperature?: number
	temperatureWarning?: number
	temperatureCritical?: number
	lifetimeUsed?: number
	smartStatus: 'healthy' | 'unhealthy' | 'unknown'
	isSystemDrive?: boolean
}

export type HddDevice = {
	type: 'hdd'
	transport: HddTransport
	device: string
	id?: string
	slot?: number
	name: string
	model: string
	serial: string
	size: number
	roundedSize: number
	temperature?: number
	smartStatus: 'healthy' | 'unhealthy' | 'unknown'
	isSystemDrive?: boolean
}

export type StorageDevice = SsdDevice | HddDevice

type SmartData = {
	temperature?: number
	temperatureWarning?: number
	temperatureCritical?: number
	lifetimeUsed?: number
	smartStatus: 'healthy' | 'unhealthy' | 'unknown'
}

// Get SMART data for any device using smartctl
async function getSmartData(devicePath: string): Promise<SmartData> {
	try {
		// smartctl uses exit code bits as status flags (e.g. bit 2 = SMART attributes failing)
		// so it can return non-zero even on success. We need to accept any exit code and parse
		// the JSON output regardless.
		const {stdout} = await $({reject: false})`smartctl -a ${devicePath} --json`
		const data = JSON.parse(stdout)

		// Temperature is reported directly in Celsius for every transport
		let temperature: number | undefined
		if (typeof data.temperature?.current === 'number') {
			temperature = data.temperature.current
		}

		const lifetimeUsed = getSmartLifetimeUsed(data)

		// Overall health assessment
		const smartStatus = data.smart_status?.passed === false ? 'unhealthy' : 'healthy'

		return {temperature, lifetimeUsed, smartStatus}
	} catch {
		return {smartStatus: 'unknown'}
	}
}

// Get NVMe warning and critical temperature thresholds from controller identify data
// These are only available via nvme-cli, smartctl doesn't expose them
async function getNvmeTemperatureThresholds(
	devicePath: string,
): Promise<{temperatureWarning?: number; temperatureCritical?: number}> {
	try {
		const {stdout} = await $`nvme id-ctrl ${devicePath} --output-format=json`
		const idCtrlData = JSON.parse(stdout)

		// wctemp = Warning Composite Temperature Threshold (Kelvin)
		// cctemp = Critical Composite Temperature Threshold (Kelvin)
		let temperatureWarning: number | undefined
		let temperatureCritical: number | undefined
		if (typeof idCtrlData.wctemp === 'number' && idCtrlData.wctemp > 0) {
			temperatureWarning = kelvinToCelsius(idCtrlData.wctemp)
		}
		if (typeof idCtrlData.cctemp === 'number' && idCtrlData.cctemp > 0) {
			temperatureCritical = kelvinToCelsius(idCtrlData.cctemp)
		}

		return {temperatureWarning, temperatureCritical}
	} catch {
		return {}
	}
}

// Get the disk/by-id name for a device
// These paths are more stable than the device name which ddepedns on enumeration order.
async function getDeviceId(deviceName: string): Promise<string | undefined> {
	const byIdDir = '/dev/disk/by-umbrel-id'
	try {
		const entries = await fse.readdir(byIdDir)
		const matchingIds: string[] = []

		for (const entry of entries) {
			try {
				// Skip partition entries (they end with -partN)
				if (/-part\d+$/.test(entry)) continue

				const fullPath = nodePath.join(byIdDir, entry)
				const target = await fse.readlink(fullPath)
				const resolvedTarget = nodePath.resolve(byIdDir, target)

				if (resolvedTarget === `/dev/${deviceName}`) matchingIds.push(entry)
			} catch {
				// Skip entries that can't be resolved
			}
		}

		if (matchingIds.length === 0) return undefined

		matchingIds.sort((a, b) => a.localeCompare(b))
		return matchingIds[0]
	} catch {
		// Directory might not exist or be readable
	}
	return undefined
}

// Get the PCIe Physical Slot Number for an NVMe device from its parent root port
// This is read from the Slot Capabilities register via lspci and is a stable identifier
// for the physical pci slot.
async function getDevicePciSlotNumber(deviceName: string): Promise<number | undefined> {
	try {
		// deviceName is like "nvme0n1", we need "nvme0" for the controller
		const controllerName = deviceName.replace(/n\d+$/, '')
		const sysfsPath = `/sys/class/nvme/${controllerName}/device`

		// Resolve the symlink to get the full device path
		// e.g., /sys/devices/pci0000:00/0000:00:1c.0/0000:01:00.0
		const devicePath = await fse.realpath(sysfsPath)

		// Extract the root port address from the path (second PCI address component)
		// Path format: /sys/devices/pci0000:00/0000:00:1c.0/0000:01:00.0
		const match = devicePath.match(/(0000:00:[0-9a-f]+\.[0-9a-f]+)\//)
		if (!match) return undefined

		const rootPortAddress = match[1]

		// Use lspci to get the Physical Slot Number from Slot Capabilities
		const {stdout} = await $`lspci -vvs ${rootPortAddress}`
		const slotMatch = stdout.match(/Slot #(\d+)/)
		if (slotMatch) return parseInt(slotMatch[1], 10)
	} catch {
		// Device might not exist or lspci might fail
	}
	return undefined
}

// Read the SCSI host driver (proc_name) backing a block device, e.g.
// "megaraid_sas" for a virtual drive on a MegaRAID card or "mpt3sas" for a
// disk on a SAS HBA. Returns undefined for devices that aren't on a SCSI host.
async function getScsiHostDriver(deviceName: string): Promise<string | undefined> {
	try {
		// /sys/block/<dev>/device resolves to the SCSI device, whose name is
		// <host>:<channel>:<target>:<lun>.
		const scsiDevice = await fse.realpath(`/sys/block/${deviceName}/device`)
		const hostNumber = nodePath.basename(scsiDevice).split(':')[0]
		if (!/^\d+$/.test(hostNumber)) return undefined
		const procName = await fse.readFile(`/sys/class/scsi_host/host${hostNumber}/proc_name`, 'utf8')
		return procName.trim() || undefined
	} catch {
		return undefined
	}
}

// Get all internal storage devices using lsblk and nvme commands
export async function getInternalStorageDevices(): Promise<StorageDevice[]> {
	type LsBlkDevice = {
		name: string
		model?: string
		serial?: string
		size?: number
		type?: string
		tran?: string
		rota?: boolean
	}

	const {stdout} = await $`lsblk --output NAME,MODEL,SERIAL,SIZE,TYPE,TRAN,ROTA --json --bytes`
	const {blockdevices} = JSON.parse(stdout) as {blockdevices: LsBlkDevice[]}

	// Filter to internal disk devices. A disk qualifies when lsblk reports a
	// supported transport, or when it sits behind a SAS/RAID adapter whose
	// transport lsblk can't classify (e.g. a hardware RAID virtual drive).
	const internalBlockDevices = (
		await Promise.all(
			blockdevices
				.filter((device) => device.type === 'disk')
				.map(async (device) => {
					const hostDriver = isSupportedInternalTransport(device.tran)
						? undefined
						: await getScsiHostDriver(device.name)
					const transport = resolveStorageTransport({tran: device.tran, hostDriver})
					return transport ? {device, transport} : undefined
				}),
		)
	).filter((entry): entry is {device: LsBlkDevice; transport: StorageTransport} => entry !== undefined)

	// Fetch SMART data, device IDs, and PCIe slot numbers for all devices in parallel
	const devices: StorageDevice[] = await Promise.all(
		internalBlockDevices.map(async ({device, transport}): Promise<StorageDevice> => {
			const devicePath = `/dev/${device.name}`
			const id = await getDeviceId(device.name).catch(() => undefined)
			const size = device.size ?? 0
			const isNvme = transport === 'nvme'
			const name = device.model?.trim() ?? getDefaultStorageDeviceName(transport)
			const model = device.model?.trim() ?? 'Unknown'
			const serial = device.serial?.trim() ?? 'Unknown'
			const roundedSize = getRoundedDeviceSize(size)
			const [smartData, temperatureThresholds, pciSlotNumber] = await Promise.all([
				getSmartData(devicePath),
				isNvme
					? getNvmeTemperatureThresholds(devicePath)
					: ({} as {temperatureWarning?: number; temperatureCritical?: number}),
				isNvme ? getDevicePciSlotNumber(device.name).catch(() => undefined) : undefined,
			])

			const isSsd = isNvme || device.rota === false

			if (isSsd) {
				return {
					type: 'ssd' as const,
					transport,
					device: device.name,
					id,
					pciSlotNumber,
					name,
					model,
					serial,
					size,
					roundedSize,
					temperature: smartData.temperature,
					temperatureWarning: temperatureThresholds.temperatureWarning,
					temperatureCritical: temperatureThresholds.temperatureCritical,
					lifetimeUsed: smartData.lifetimeUsed,
					smartStatus: smartData.smartStatus,
				}
			}

			return {
				type: 'hdd' as const,
				// An NVMe transport always classifies as an SSD above.
				transport: transport as HddTransport,
				device: device.name,
				id,
				name,
				model,
				serial,
				size,
				roundedSize,
				temperature: smartData.temperature,
				smartStatus: smartData.smartStatus,
			}
		}),
	)

	// Sort by id
	return devices.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''))
}

export default class InternalStorage {
	#umbreld: Umbreld
	logger: Umbreld['logger']

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`hardware:${name.toLowerCase()}`)
	}

	async start() {
		this.logger.log('Starting internal storage')
	}

	async stop() {
		this.logger.log('Stopping internal storage')
	}

	// Get all internal storage devices with their info
	async getDevices(): Promise<StorageDevice[]> {
		let devices = await getInternalStorageDevices()

		// Flag disks that back the running system so they're never offered as RAID storage
		const systemDiskNames = await getSystemDiskNames(this.#umbreld.dataDirectory)
		devices = devices.map((device) => ({...device, isSystemDrive: systemDiskNames.has(device.device)}))

		// Attach slot numbers on Umbrel Pro
		if (await this.#umbreld.hardware.umbrelPro.isUmbrelPro()) {
			const ssdDevices = devices.filter((device) => device.type === 'ssd')
			const otherDevices = devices.filter((device) => device.type !== 'ssd')
			devices = [
				...ssdDevices.map((device) => ({
					...device,
					slot: this.#umbreld.hardware.umbrelPro.getSsdSlotFromPciSlotNumber(device.pciSlotNumber),
				})),
				...otherDevices,
			]
		}

		// Sort by slot number if all devices have slots
		const haveMissingSlots = devices.some((device) => device.slot === undefined)
		if (!haveMissingSlots) devices.sort((a, b) => a.slot! - b.slot!)

		return devices
	}
}
