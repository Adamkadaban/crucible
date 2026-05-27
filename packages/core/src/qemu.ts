import { defaultCrucibleConfig, type CrucibleConfig } from "./config.js";
import { CrucibleError } from "./errors.js";

const DEFAULT_QEMU_EXECUTABLE = "qemu-system-x86_64";
const DEFAULT_NETDEV_ID = "crucible-net0";
const DEFAULT_DISK_ID = "crucible-disk0";
const QGA_CHARDEV_ID = "crucible-qga0";

export type QemuDiskPlan = {
  readonly path: string;
  readonly format: "qcow2";
  readonly bus: CrucibleConfig["virtio"]["diskBus"];
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
  readonly extraArgs: readonly string[];
};

export type QemuPlanOptions = {
  readonly config?: CrucibleConfig;
  readonly executable?: string;
  readonly diskPath?: string;
};

export function buildQemuCommandPlan(options: QemuPlanOptions = {}): QemuCommandPlan {
  const config = options.config ?? defaultCrucibleConfig;
  const executable = options.executable ?? DEFAULT_QEMU_EXECUTABLE;
  const diskPath = options.diskPath ?? getDefaultDiskPath(config);
  validateQemuSuboptionValue("diskPath", diskPath);
  validateQemuSuboptionValue("qmp.socketPath", config.qmp.socketPath);
  validateQemuSuboptionValue("qga.socketPath", config.qga.socketPath);
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
    ...buildDiskArgs(config, diskPath),
    ...buildNetworkArgs(config),
    ...buildGuestAgentArgs(config),
    "-qmp",
    `unix:${config.qmp.socketPath},server=on,wait=off`,
    ...buildOptionalVirtioDeviceArgs(config),
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
    extraArgs: config.vm.extraQemuArgs,
  };
}

function getDefaultDiskPath(config: CrucibleConfig): string {
  return `${config.artifacts.directory}/disks/${config.vm.name}.qcow2`;
}

export function renderQemuDryRun(plan: QemuCommandPlan): string {
  return [
    "QEMU dry run plan:",
    `- create disk: ${plan.dryRunCreateDiskCommand}`,
    `- command: ${plan.dryRunCommand}`,
    `- disk: ${plan.disk.path} (${plan.disk.format}, ${plan.disk.bus})`,
    `- qmp socket: ${plan.sockets.qmp}`,
    `- qga socket: ${plan.sockets.qga}`,
  ].join("\n");
}

function buildDiskArgs(config: CrucibleConfig, diskPath: string): readonly string[] {
  const drive = `file=${diskPath},if=none,format=qcow2,id=${DEFAULT_DISK_ID},cache=none,discard=unmap`;

  if (config.virtio.diskBus === "virtio-blk") {
    return ["-drive", drive, "-device", `virtio-blk-pci,drive=${DEFAULT_DISK_ID}`];
  }

  return [
    "-device",
    "virtio-scsi-pci,id=scsi0",
    "-drive",
    drive,
    "-device",
    `scsi-hd,drive=${DEFAULT_DISK_ID}`,
  ];
}

function buildNetworkArgs(config: CrucibleConfig): readonly string[] {
  if (config.network.mode === "isolated") {
    return [];
  }

  return [
    "-netdev",
    `user,id=${DEFAULT_NETDEV_ID}`,
    "-device",
    `${config.virtio.networkDevice},netdev=${DEFAULT_NETDEV_ID}`,
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
