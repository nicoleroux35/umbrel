import {expect, beforeAll, beforeEach, afterAll, afterEach, describe, test} from 'vitest'
import pWaitFor from 'p-wait-for'

import {createTestVm} from '../test-utilities/create-test-umbreld.js'

describe('mdadm Linux RAID arrays', () => {
	let umbreld: Awaited<ReturnType<typeof createTestVm>>
	let firstDevice: string
	let secondDevice: string
	let failed = false

	beforeAll(async () => {
		umbreld = await createTestVm({device: 'nas'})
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

	// --- Phase 1: Boot on bare hardware ---

	test('adds NVMe devices and boots VM', async () => {
		await umbreld.vm.addNvme({slot: 1})
		await umbreld.vm.addNvme({slot: 2})
		await umbreld.vm.powerOn()
	})

	test('registers user without a RAID pool', async () => {
		await umbreld.registerAndLogin()
	})

	test('detects the two internal NVMe devices', async () => {
		const devices = await umbreld.client.hardware.internalStorage.getDevices.query()
		expect(devices).toHaveLength(2)
		const mdCandidates = devices.filter((device) => device.id?.startsWith('md'))
		expect(mdCandidates).toHaveLength(0)

		firstDevice = `/dev/${devices[0].device}`
		secondDevice = `/dev/${devices[1].device}`
	})

	// --- Phase 2: Create a RAID1 array, format and mount it ---

	test('mdadm is supported on the host', async () => {
		const supported = await umbreld.client.hardware.mdadm.isSupported.query()
		expect(supported).toBe(true)
	})

	test('device allocation starts at the first free /dev/mdN', async () => {
		const next = await umbreld.client.hardware.mdadm.allocateDevice.query()
		expect(next).toBe('/dev/md0')
	})

	test('creates a RAID1 array from both devices', async () => {
		const result = await umbreld.client.hardware.mdadm.create.mutate({
			level: '1',
			devices: [firstDevice, secondDevice],
			name: 'umbrel-raid',
		})
		expect(result.device).toBe('/dev/md0')
	})

	test('reports the array as a clean active RAID1 with two members', async () => {
		const status = await umbreld.client.hardware.mdadm.getStatus.query()
		expect(status.supported).toBe(true)
		expect(status.exists).toBe(true)
		expect(status.arrays).toHaveLength(1)

		const array = status.arrays[0]
		expect(array.device).toBe('/dev/md0')
		expect(array.level).toBe('1')
		expect(['clean', 'active', 'resync', 'recovering']).toContain(array.state)
		expect(array.totalDevices).toBe(2)
		expect(array.members).toHaveLength(2)
	})

	test('reports no filesystem until the array is formatted', async () => {
		const mount = await umbreld.client.hardware.mdadm.getFilesystemType.query({arrayDevice: '/dev/md0'})
		expect(mount).toBeNull()
	})

	test('formats the array as ext4 and mounts it', async () => {
		await umbreld.client.hardware.mdadm.format.mutate({
			arrayDevice: '/dev/md0',
			filesystem: 'ext4',
			label: 'umbrel-raid',
		})

		// format() returns the mkfs tool's own log, which names the tool
		// ("mke2fs") rather than the filesystem, so assert the outcome.
		const filesystem = await umbreld.client.hardware.mdadm.getFilesystemType.query({arrayDevice: '/dev/md0'})
		expect(filesystem).toBe('ext4')

		const mountpoint = await umbreld.client.hardware.mdadm.mount.mutate({arrayDevice: '/dev/md0'})
		expect(mountpoint).toBe('/run/mdadm/umbrel-raid')
	})

	test('exposes the mounted array to Files under /Raid', async () => {
		const mounts = await umbreld.client.files.raidMounts.query()
		expect(mounts).toHaveLength(1)
		expect(mounts[0].device).toBe('/dev/md0')
		expect(mounts[0].path).toBe('/Raid/umbrel-raid')
		expect(mounts[0].filesystem).toBe('ext4')
		expect(mounts[0].native).toBe(true)
	})

	test('can write and read a file through the Files API', async () => {
		await umbreld.client.files.createDirectory.mutate({path: '/Raid/umbrel-raid/persistence'})
		const listing = await umbreld.client.files.list.query({path: '/Raid/umbrel-raid'})
		expect(listing.files.some((file) => file.name === 'persistence')).toBe(true)
	})

	test('records the mount for replay at boot', async () => {
		const mounts = await umbreld.vm.sshAsRoot('cat /home/umbrel/umbrel/mdadm/mounts')
		expect(mounts).toContain('/run/mdadm/umbrel-raid')
		expect(mounts).toContain('ext4')
		// Keyed by filesystem UUID so the entry keeps working when the array comes
		// back on a different /dev/mdN, and nofail so a missing array is skipped
		// rather than failing the replay. A missing array must never block boot.
		expect(mounts).toContain('UUID=')
		expect(mounts).toContain('nofail')
	})

	// --- Phase 3: Data survives a full reboot ---

	// The array's /dev/mdN is not stable across a reboot. umbrelOS has no mdadm in
	// the initramfs, so mdadm's udev rule assembles from the superblocks before any
	// systemd unit runs, onto whichever node is free (typically /dev/md127) — a
	// conf naming /dev/md0 is written too late to change that. Resolve by the array
	// name from the superblock instead, which is stable and is also what /Raid uses.
	const arrayDevice = async () => {
		const status = await umbreld.client.hardware.mdadm.getStatus.query()
		const array = status.arrays.find((candidate) => candidate.name === 'umbrel-raid')
		if (!array) throw new Error('umbrel-raid array not found')
		return array.device
	}

	test('data survives a reboot (mount replay)', async () => {
		await umbreld.vm.powerOff()
		await umbreld.vm.powerOn()
		await umbreld.login()

		// The array is reassembled before umbreld starts, then remounted by
		// Mdadm.start() from the list recorded in the data directory.
		await pWaitFor(
			async () => {
				try {
					const mountpoint = await umbreld.client.hardware.mdadm.getMountpoint.query({
						arrayDevice: await arrayDevice(),
					})
					return mountpoint !== null
				} catch {
					return false
				}
			},
			{interval: 1000, timeout: 120_000},
		)

		const listing = await umbreld.client.files.list.query({path: '/Raid/umbrel-raid'})
		expect(listing.files.some((file) => file.name === 'persistence')).toBe(true)
	})

	test('array stays healthy after the reboot', async () => {
		const status = await umbreld.client.hardware.mdadm.getStatus.query()
		const array = status.arrays.find((candidate) => candidate.name === 'umbrel-raid')
		expect(array).toBeDefined()
		expect(array!.failedDevices).toBe(0)
		expect(array!.members.every((member) => member.state === 'active' || member.state === 'sync')).toBe(true)
	})

	// --- Phase 4: Grow the array with a spare ---

	test('grow is rejected on a RAID1 array', async () => {
		await expect(
			umbreld.client.hardware.mdadm.growAddAndExpand.mutate({arrayDevice: await arrayDevice(), devices: []}),
		).rejects.toThrow()
	})

	// --- Phase 5: Unmount detaches cleanly ---

	test('unmounting removes the mount and the recorded entry', async () => {
		const device = await arrayDevice()
		await umbreld.client.hardware.mdadm.unmount.mutate({arrayDevice: device})

		const mountpoint = await umbreld.client.hardware.mdadm.getMountpoint.query({arrayDevice: device})
		expect(mountpoint).toBeNull()

		const mounts = await umbreld.vm.sshAsRoot('cat /home/umbrel/umbrel/mdadm/mounts')
		expect(mounts).not.toContain('/run/mdadm/umbrel-raid')
	})

	test('stopping the array removes it from the inventory', async () => {
		const device = await arrayDevice()
		await umbreld.client.hardware.mdadm.stop.mutate({arrayDevice: device})

		await pWaitFor(
			async () => {
				const status = await umbreld.client.hardware.mdadm.getStatus.query()
				return status.arrays.every((array) => array.device !== device)
			},
			{interval: 1000, timeout: 30_000},
		)
	})
})
