import {expect, beforeAll, beforeEach, afterAll, afterEach, describe, test} from 'vitest'
import pWaitFor from 'p-wait-for'

import {createTestVm} from '../test-utilities/create-test-umbreld.js'

describe('SAS internal storage', () => {
	let umbreld: Awaited<ReturnType<typeof createTestVm>>
	let sasHddDeviceId: string
	let sasSsdDeviceId: string
	let initialTotalSpace: number
	let failed = false

	beforeAll(async () => {
		umbreld = await createTestVm({device: 'umbrel-home'})
	})

	afterAll(async () => {
		await umbreld?.cleanup()
	})

	afterEach(({task}) => {
		if (task.result?.state === 'fail') failed = true
	})

	beforeEach(({skip}) => {
		if (failed) skip()
	})

	// --- Phase 1: Boot and detect SAS disks behind an emulated SAS HBA ---

	test('adds a SAS HDD and a SAS SSD behind a SAS HBA and boots VM', async () => {
		await umbreld.vm.addSasHdd({slot: 1})
		await umbreld.vm.addSasSsd({slot: 2})
		await umbreld.vm.powerOn()
	})

	test('detects both SAS disks with the SAS transport', async () => {
		const devices = await umbreld.unauthenticatedClient.hardware.internalStorage.getDevices.query()
		const sasDevices = devices.filter((device) => device.transport === 'sas')
		expect(sasDevices).toHaveLength(2)

		// The emulated HBA presents one rotational and one non-rotational disk
		const hdd = sasDevices.find((device) => device.type === 'hdd')
		const ssd = sasDevices.find((device) => device.type === 'ssd')
		expect(hdd).toBeDefined()
		expect(ssd).toBeDefined()

		sasHddDeviceId = hdd!.id!
		sasSsdDeviceId = ssd!.id!
		expect(sasHddDeviceId).toBeDefined()
		expect(sasSsdDeviceId).toBeDefined()
	})

	// --- Phase 2: SAS disks are treated as internal storage, not external USB storage ---

	test('does not offer SAS disks as external storage', async () => {
		const externalDevices = await umbreld.unauthenticatedClient.files.externalDevices.query()
		const externalIds = externalDevices.map((device) => device.id)
		expect(externalIds).not.toContain(sasHddDeviceId)
		expect(externalIds).not.toContain(sasSsdDeviceId)
	})

	// --- Phase 3: Setup validation - mixed types should fail ---

	test('rejects creating a RAID array with mixed SAS SSD and HDD devices', async () => {
		await expect(
			umbreld.unauthenticatedClient.user.register.mutate({
				name: 'satoshi',
				password: 'moneyprintergobrrr',
				raidDevices: [sasHddDeviceId, sasSsdDeviceId],
				raidType: 'storage',
			}),
		).rejects.toThrow('Cannot mix SSDs and HDDs')
	})

	// --- Phase 4: Setup a storage pool on the SAS HDD ---

	test('registers user with a single SAS HDD RAID config (triggers reboot)', async () => {
		await umbreld.signup({raidDevices: [sasHddDeviceId], raidType: 'storage'})
	})

	test('waits for RAID setup to complete and logs in', async () => {
		await pWaitFor(
			async () => {
				try {
					return await umbreld.unauthenticatedClient.hardware.raid.checkInitialRaidSetupStatus.query()
				} catch (error) {
					// Ignore connection errors while VM is rebooting
					if (error instanceof Error && error.message.includes('fetch failed')) {
						return false
					}
					// Rethrow server errors (e.g., initialRaidSetupError)
					throw error
				}
			},
			{interval: 2000, timeout: 600_000},
		)
		await umbreld.login()
	})

	test('reports correct RAID status with the SAS HDD', async () => {
		const status = await umbreld.client.hardware.raid.getStatus.query()
		expect(status.exists).toBe(true)
		expect(status.raidType).toBe('storage')
		expect(status.status).toBe('ONLINE')
		expect(status.devices).toHaveLength(1)
		expect(status.devices![0].id).toBe(sasHddDeviceId)
		initialTotalSpace = status.totalSpace!
		expect(initialTotalSpace).toBeGreaterThan(0)
	})

	test('creates marker directory to verify data consistency', async () => {
		await umbreld.client.files.createDirectory.mutate({path: '/Home/data-consistency-marker'})
		const listing = await umbreld.client.files.list.query({path: '/Home'})
		expect(listing.files.some((f) => f.name === 'data-consistency-marker')).toBe(true)
	})

	// --- Phase 5: Persistence across reboot ---

	test('shuts down and reboots with the SAS disks attached', async () => {
		await umbreld.vm.powerOff()
		await umbreld.vm.powerOn()
	})

	test('logs in after reboot', async () => {
		await umbreld.waitForStartup({waitForUser: true})
		await umbreld.login()
	})

	test('still detects the SAS disks with the SAS transport after reboot', async () => {
		const devices = await umbreld.client.hardware.internalStorage.getDevices.query()
		const sasDevices = devices.filter((device) => device.transport === 'sas')
		expect(sasDevices).toHaveLength(2)
		expect(sasDevices.map((device) => device.id).sort()).toEqual([sasHddDeviceId, sasSsdDeviceId].sort())
	})

	test('RAID pool is still online after reboot', async () => {
		const status = await umbreld.client.hardware.raid.getStatus.query()
		expect(status.exists).toBe(true)
		expect(status.status).toBe('ONLINE')
		expect(status.devices).toHaveLength(1)
		expect(status.devices![0].id).toBe(sasHddDeviceId)
	})

	// --- Phase 6: Expand the pool with a second SAS HDD ---

	test('shuts down and adds a second SAS HDD', async () => {
		await umbreld.vm.powerOff()
		await umbreld.vm.addSasHdd({slot: 3})
		await umbreld.vm.powerOn()
	})

	test('logs in after adding the second SAS HDD', async () => {
		await umbreld.waitForStartup({waitForUser: true})
		await umbreld.login()
	})

	test('detects the second SAS HDD', async () => {
		const devices = await umbreld.client.hardware.internalStorage.getDevices.query()
		const sasHdds = devices.filter((device) => device.transport === 'sas' && device.type === 'hdd')
		expect(sasHdds).toHaveLength(2)

		const secondSasHdd = sasHdds.find((device) => device.id !== sasHddDeviceId)
		expect(secondSasHdd).toBeDefined()
		await umbreld.client.hardware.raid.addDevice.mutate({deviceId: secondSasHdd!.id!})
	})

	test('reports correct RAID status with both SAS HDDs', async () => {
		const status = await umbreld.client.hardware.raid.getStatus.query()
		expect(status.exists).toBe(true)
		expect(status.raidType).toBe('storage')
		expect(status.status).toBe('ONLINE')
		expect(status.devices).toHaveLength(2)
		expect(status.totalSpace!).toBeGreaterThan(initialTotalSpace)
	})

	test('marker directory still exists after expansion', async () => {
		const listing = await umbreld.client.files.list.query({path: '/Home'})
		expect(listing.files.some((f) => f.name === 'data-consistency-marker')).toBe(true)
	})
})
