import { defaultCrucibleConfig, type CrucibleConfig } from "./config.js";
import { CrucibleError } from "./errors.js";
import { buildNetworkPlan, type QemuNetworkPlan } from "./network.js";

const DEFAULT_QEMU_EXECUTABLE = "qemu-system-x86_64";
const DEFAULT_DISK_ID = "crucible-disk0";
const QGA_CHARDEV_ID = "crucible-qga0";

export type QemuDiskPlan = {
  readonly path: string;
  readonly format: "qcow2";
  readonly bus: CrucibleConfig["virtio"]["diskBus"];
};

export type QemuBootMediaPlan = {
  readonly windowsIsoPath?: string;
  readonly virtioIsoPath?: string;
  readonly driverBundlePath?: string;
  readonly autounattendIsoPath?: string;
  readonly ovmfCodePath?: string;
  readonly ovmfVarsPath?: string;
  readonly swtpmSocketPath?: string;
};

export type QemuSocketPlan = {
  readonly qmp: string;
  readonly qga: string;
};

export type QemuCommandPlan = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly dryRunCommand: string;
  readonly createDiskCommand: readonly string[];
  readonly dryRunCreateDiskCommand: string;
  readonly disk: QemuDiskPlan;
  readonly sockets: QemuSocketPlan;
  readonly network: QemuNetworkPlan;
  readonly bootMedia?: QemuBootMediaPlan;
  readonly extraArgs: readonly string[];
};

export type QemuPlanOptions = {
  readonly config?: CrucibleConfig;
  readonly executable?: string;
  readonly diskPath?: string;
  readonly bootMedia?: QemuBootMediaOptions;
};

export type QemuBootMediaOptions = {
  readonly windowsIsoPath?: string;
  readonly virtioIsoPath?: string;
  readonly driverBundlePath?: string;
  readonly autounattendIsoPath?: string;
  readonly ovmfCodePath?: string;
  readonly ovmfVarsPath?: string;
  readonly swtpmSocketPath?: string;
};

export function buildQemuCommandPlan(options: QemuPlanOptions = {}): QemuCommandPlan {
  const config = options.config ?? defaultCrucibleConfig;
  const executable = options.executable ?? DEFAULT_QEMU_EXECUTABLE;
  const diskPath = options.diskPath ?? getDefaultDiskPath(config);
  validateQemuSuboptionValue("vm.name", config.vm.name);
  validateQemuSuboptionValue("diskPath", diskPath);
  validateQemuSuboptionValue("qmp.socketPath", config.qmp.socketPath);
  validateQemuSuboptionValue("qga.socketPath", config.qga.socketPath);
  const network = buildNetworkPlan({
    config: config.network,
    vmName: config.vm.name,
    networkDevice: config.virtio.networkDevice,
  }).qemu;
  const createDiskCommand = [
    "qemu-img",
    "create",
    "-f",
    "qcow2",
    diskPath,
    `${config.vm.diskGiB}G`,
  ];
  const args = [
    "-name",
    config.vm.name,
    "-machine",
    "type=q35,accel=kvm",
    "-cpu",
    "host",
    "-smp",
    String(config.vm.cpus),
    "-m",
    `${config.vm.memoryMiB}M`,
    ...buildBootOrderArgs(options.bootMedia),
    ...buildSataControllerArgs(options.bootMedia),
    ...buildFirmwareArgs(options.bootMedia),
    ...buildDiskArgs(config, diskPath),
    ...buildBootMediaArgs(options.bootMedia),
    ...network.args,
    ...buildGuestAgentArgs(config),
    "-qmp",
    `unix:${config.qmp.socketPath},server=on,wait=off`,
    ...buildOptionalVirtioDeviceArgs(config),
    ...buildTpmArgs(options.bootMedia),
    ...config.vm.extraQemuArgs,
  ];

  return {
    executable,
    args,
    dryRunCommand: shellQuoteCommand(executable, args),
    createDiskCommand,
    dryRunCreateDiskCommand: shellQuoteCommand(
      createDiskCommand[0] ?? "qemu-img",
      createDiskCommand.slice(1),
    ),
    disk: {
      path: diskPath,
      format: "qcow2",
      bus: config.virtio.diskBus,
    },
    sockets: {
      qmp: config.qmp.socketPath,
      qga: config.qga.socketPath,
    },
    network,
    bootMedia: options.bootMedia,
    extraArgs: config.vm.extraQemuArgs,
  };
}

function buildSataControllerArgs(bootMedia?: QemuBootMediaOptions): readonly string[] {
  if (
    bootMedia?.windowsIsoPath === undefined &&
    bootMedia?.virtioIsoPath === undefined &&
    bootMedia?.autounattendIsoPath === undefined
  ) {
    return [];
  }

  return ["-device", "ich9-ahci,id=crucible-sata0"];
}

function buildBootOrderArgs(bootMedia?: QemuBootMediaOptions): readonly string[] {
  if (bootMedia?.windowsIsoPath === undefined) {
    return [];
  }

  return ["-boot", "once=d,order=c"];
}

function buildFirmwareArgs(bootMedia?: QemuBootMediaOptions): readonly string[] {
  if (bootMedia?.ovmfCodePath === undefined || bootMedia.ovmfVarsPath === undefined) {
    return [];
  }

  validateQemuSuboptionValue("bootMedia.ovmfCodePath", bootMedia.ovmfCodePath);
  validateQemuSuboptionValue("bootMedia.ovmfVarsPath", bootMedia.ovmfVarsPath);
  return [
    "-drive",
    `if=pflash,format=raw,readonly=on,file=${bootMedia.ovmfCodePath}`,
    "-drive",
    `if=pflash,format=raw,file=${bootMedia.ovmfVarsPath}`,
  ];
}

function buildBootMediaArgs(bootMedia?: QemuBootMediaOptions): readonly string[] {
  const args: string[] = [];

  if (bootMedia?.windowsIsoPath !== undefined) {
    // bootindex 1 lets OVMF enumerate the Windows installer ESP as FS0 and
    // boot bootmgr ahead of the empty disk (which uses bootindex 10).
    args.push(...isoDriveArgs("crucible-windows-install", bootMedia.windowsIsoPath, 0, 1));
  }

  if (bootMedia?.autounattendIsoPath !== undefined) {
    args.push(...isoDriveArgs("crucible-autounattend", bootMedia.autounattendIsoPath, 1));
  }

  if (bootMedia?.virtioIsoPath !== undefined) {
    args.push(...isoDriveArgs("crucible-virtio", bootMedia.virtioIsoPath, 2));
  }

  return args;
}

function isoDriveArgs(
  id: string,
  filePath: string,
  index: number,
  bootindex?: number,
): readonly string[] {
  validateQemuSuboptionValue(id, filePath);
  const device =
    bootindex === undefined
      ? `ide-cd,drive=${id},bus=crucible-sata0.${index}`
      : `ide-cd,drive=${id},bus=crucible-sata0.${index},bootindex=${bootindex}`;
  return ["-drive", `file=${filePath},media=cdrom,if=none,readonly=on,id=${id}`, "-device", device];
}

function buildTpmArgs(bootMedia?: QemuBootMediaOptions): readonly string[] {
  if (bootMedia?.swtpmSocketPath === undefined) {
    return [];
  }

  validateQemuSuboptionValue("bootMedia.swtpmSocketPath", bootMedia.swtpmSocketPath);
  return [
    "-chardev",
    `socket,id=crucible-tpm,path=${bootMedia.swtpmSocketPath}`,
    "-tpmdev",
    "emulator,id=crucible-tpmdev,chardev=crucible-tpm",
    "-device",
    "tpm-tis,tpmdev=crucible-tpmdev",
  ];
}

function getDefaultDiskPath(config: CrucibleConfig): string {
  return `${config.artifacts.directory}/disks/${config.vm.name}.qcow2`;
}

export function renderQemuCreateDryRun(plan: QemuCommandPlan): string {
  return [
    "QEMU dry run plan:",
    `- create disk: ${plan.dryRunCreateDiskCommand}`,
    ...renderQemuStartDryRunLines(plan),
  ].join("\n");
}

export function renderQemuStartDryRun(plan: QemuCommandPlan): string {
  return ["QEMU dry run plan:", ...renderQemuStartDryRunLines(plan)].join("\n");
}

function renderQemuStartDryRunLines(plan: QemuCommandPlan): readonly string[] {
  const controlMappings = plan.network.portForwards.map(
    (forward) =>
      `- guest control: ${forward.hostListenAddress}:${forward.hostPort} -> ${forward.guestAddress}:${forward.guestPort}`,
  );

  return [
    `- command: ${plan.dryRunCommand}`,
    `- disk: ${plan.disk.path} (${plan.disk.format}, ${plan.disk.bus})`,
    `- network mode: ${plan.network.mode} (${plan.network.backend})`,
    ...controlMappings,
    `- qmp socket: ${plan.sockets.qmp}`,
    `- qga socket: ${plan.sockets.qga}`,
  ];
}

function buildDiskArgs(config: CrucibleConfig, diskPath: string): readonly string[] {
  const drive = `file=${diskPath},if=none,format=qcow2,id=${DEFAULT_DISK_ID},cache=none,discard=unmap`;

  // bootindex 10 keeps the install CD (bootindex 1) ahead of the empty disk
  // during first boot so OVMF actually enumerates the Windows installer ESP
  // as FS0. Once Windows is installed the CD prompt times out and OVMF
  // falls through to the disk.
  if (config.virtio.diskBus === "virtio-blk") {
    return ["-drive", drive, "-device", `virtio-blk-pci,drive=${DEFAULT_DISK_ID},bootindex=10`];
  }

  return [
    "-device",
    "virtio-scsi-pci,id=scsi0",
    "-drive",
    drive,
    "-device",
    `scsi-hd,drive=${DEFAULT_DISK_ID},bus=scsi0.0,bootindex=10`,
  ];
}

function buildGuestAgentArgs(config: CrucibleConfig): readonly string[] {
  return [
    "-device",
    "virtio-serial-pci",
    "-chardev",
    `socket,path=${config.qga.socketPath},server=on,wait=off,id=${QGA_CHARDEV_ID}`,
    "-device",
    `virtserialport,chardev=${QGA_CHARDEV_ID},name=org.qemu.guest_agent.0`,
  ];
}

function validateQemuSuboptionValue(name: string, value: string): void {
  if (/[,\\]/.test(value)) {
    throw new CrucibleError(
      "CONFIG_INVALID",
      `${name} cannot contain ',' or '\\' because QEMU comma-delimited suboptions would misparse it`,
      { name, value },
    );
  }
}

function buildOptionalVirtioDeviceArgs(config: CrucibleConfig): readonly string[] {
  return [
    ...(config.virtio.balloon ? ["-device", "virtio-balloon-pci"] : []),
    ...(config.virtio.rng
      ? [
          "-object",
          "rng-random,id=rng0,filename=/dev/urandom",
          "-device",
          "virtio-rng-pci,rng=rng0",
        ]
      : []),
  ];
}

function shellQuoteCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'\\''`)}'`;
}
