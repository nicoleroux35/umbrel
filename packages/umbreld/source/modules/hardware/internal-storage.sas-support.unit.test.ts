import {describe, test, expect} from 'vitest'

import {
	getDefaultStorageDeviceName,
	getSmartLifetimeUsed,
	isSasControllerDriver,
	isSupportedInternalTransport,
	resolveStorageTransport,
} from './internal-storage.js'

describe('internal storage transports', () => {
	test('accepts NVMe, SATA and SAS transports', () => {
		expect(isSupportedInternalTransport('nvme')).toBe(true)
		expect(isSupportedInternalTransport('sata')).toBe(true)
		expect(isSupportedInternalTransport('sas')).toBe(true)
	})

	test('rejects transports that are not internal storage', () => {
		for (const transport of ['usb', 'mmc', 'iscsi', 'fc', '', null, undefined]) {
			expect(isSupportedInternalTransport(transport)).toBe(false)
		}
	})

	test('recognises SAS and hardware RAID adapter drivers', () => {
		for (const driver of ['mpt3sas', 'mpt2sas', 'mptsas', 'megaraid_sas', 'aacraid', 'hpsa', 'smartpqi']) {
			expect(isSasControllerDriver(driver)).toBe(true)
		}
	})

	test('normalises the adapter driver name before matching', () => {
		expect(isSasControllerDriver(' MPT3SAS ')).toBe(true)
		expect(isSasControllerDriver('MegaRAID_SAS')).toBe(true)
	})

	test('does not treat non-SAS adapters as SAS', () => {
		for (const driver of ['ahci', 'usb-storage', 'virtio_scsi', 'nvme', 'sata_sil24', '', null, undefined]) {
			expect(isSasControllerDriver(driver)).toBe(false)
		}
	})

	test('resolves a directly attached SAS disk', () => {
		expect(resolveStorageTransport({tran: 'sas'})).toBe('sas')
	})

	test('resolves a disk behind an unlabelled RAID adapter as SAS', () => {
		// Virtual drives behind a RAID-mode MegaRAID card report no transport
		expect(resolveStorageTransport({tran: '', hostDriver: 'megaraid_sas'})).toBe('sas')
		expect(resolveStorageTransport({hostDriver: 'mpt3sas'})).toBe('sas')
	})

	test('ignores disks that are not internal storage', () => {
		expect(resolveStorageTransport({tran: 'usb', hostDriver: 'usb-storage'})).toBeUndefined()
		expect(resolveStorageTransport({tran: '', hostDriver: 'ahci'})).toBeUndefined()
		expect(resolveStorageTransport({})).toBeUndefined()
	})

	test('prefers the transport reported by lsblk over the adapter driver', () => {
		// A SATA disk on a SAS HBA reports its own transport and stays SATA
		expect(resolveStorageTransport({tran: 'sata', hostDriver: 'mpt3sas'})).toBe('sata')
	})
})

describe('internal storage device names', () => {
	test('names disks that report no model by transport', () => {
		expect(getDefaultStorageDeviceName('nvme')).toBe('Unknown NVMe Device')
		expect(getDefaultStorageDeviceName('sata')).toBe('Unknown SATA Device')
		expect(getDefaultStorageDeviceName('sas')).toBe('Unknown SAS Device')
	})
})

describe('SMART endurance', () => {
	test('reads the NVMe percentage used', () => {
		expect(getSmartLifetimeUsed({nvme_smart_health_information_log: {percentage_used: 42}})).toBe(42)
	})

	test('reads the SAS/SCSI percentage used endurance indicator', () => {
		expect(getSmartLifetimeUsed({scsi_percentage_used_endurance_indicator: 7})).toBe(7)
	})

	test('prefers the NVMe value when both are present', () => {
		expect(
			getSmartLifetimeUsed({
				nvme_smart_health_information_log: {percentage_used: 5},
				scsi_percentage_used_endurance_indicator: 9,
			}),
		).toBe(5)
	})

	test('returns undefined when the drive reports no endurance', () => {
		expect(getSmartLifetimeUsed({})).toBeUndefined()
	})
})
