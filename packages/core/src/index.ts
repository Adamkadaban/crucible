export const CRUCIBLE_VERSION = "0.0.0";

export const DEFAULT_MEDIA_CACHE_DIR = "media/cache";

export type ManualDownload = {
  readonly name: string;
  readonly url: string;
  readonly cacheFileName: string;
};

export const MANUAL_DOWNLOADS: readonly ManualDownload[] = [
  {
    name: "Windows 11 Enterprise Evaluation page",
    url: "https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise",
    cacheFileName: "Windows11EnterpriseEvaluation.iso",
  },
  {
    name: "Windows 11 Enterprise Evaluation ISO fwlink",
    url: "https://go.microsoft.com/fwlink/p/?linkid=2195682&clcid=0x409&culture=en-us&country=us",
    cacheFileName: "Windows11EnterpriseEvaluation.iso",
  },
  {
    name: "Windows Server 2025 Evaluation page",
    url: "https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2025",
    cacheFileName: "WindowsServer2025Evaluation.iso",
  },
  {
    name: "Windows Server 2025 Evaluation ISO fwlink",
    url: "https://go.microsoft.com/fwlink/?linkid=2345730&clcid=0x409&culture=en-us&country=us",
    cacheFileName: "WindowsServer2025Evaluation.iso",
  },
  {
    name: "stable virtio-win ISO",
    url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso",
    cacheFileName: "virtio-win-stable.iso",
  },
  {
    name: "latest virtio-win ISO",
    url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-virtio/virtio-win.iso",
    cacheFileName: "virtio-win-latest.iso",
  },
  {
    name: "latest virtio-win guest tools",
    url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-virtio/virtio-win-guest-tools.exe",
    cacheFileName: "virtio-win-guest-tools.exe",
  },
];

export function getManualDownloadInstructions(cacheDir = DEFAULT_MEDIA_CACHE_DIR): string {
  const lines = MANUAL_DOWNLOADS.map(
    (download) => `- ${download.name}: ${download.url} -> ${cacheDir}/${download.cacheFileName}`,
  );

  return [
    "If automated media downloads are blocked, manually download the needed files:",
    ...lines,
    "Custom paths can be supplied in crucible.config.json.",
  ].join("\n");
}
