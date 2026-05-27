import path from "node:path";

export const DEFAULT_MEDIA_CACHE_DIR = "media/cache";

export type MediaKind = "windowsIso" | "virtioIso" | "driverBundle";

export type MediaProfileName = "windows11-enterprise-eval" | "windows-server-2025-eval";

export type ManualDownload = {
  readonly kind: MediaKind;
  readonly name: string;
  readonly url: string;
  readonly cacheFileName: string;
};

export type MediaOverride = {
  readonly path?: string;
  readonly url?: string;
  readonly sha256?: string;
};

export type MediaCacheConfig = {
  readonly cacheDir: string;
  readonly profile: MediaProfileName;
  readonly windowsIso?: MediaOverride;
  readonly virtioIso?: MediaOverride;
  readonly driverBundle?: MediaOverride;
};

export type MediaCacheEntry = {
  readonly kind: MediaKind;
  readonly name: string;
  readonly sourceUrl?: string;
  readonly overridePath?: string;
  readonly cachePath: string;
  readonly sha256?: string;
  readonly required: boolean;
  readonly manualUrl: string;
};

export type MediaCachePlan = {
  readonly cacheDirectory: string;
  readonly profile: MediaProfileName;
  readonly entries: readonly MediaCacheEntry[];
  readonly manualDownloads: readonly ManualDownload[];
};

type DefaultMediaSource = {
  readonly kind: MediaKind;
  readonly name: string;
  readonly url: string;
  readonly cacheFileName: string;
  readonly sha256?: string;
  readonly required: boolean;
  readonly profiles: readonly MediaProfileName[];
};

export const DEFAULT_MEDIA_SOURCES: readonly DefaultMediaSource[] = [
  {
    kind: "windowsIso",
    name: "Windows 11 Enterprise Evaluation ISO",
    url: "https://go.microsoft.com/fwlink/p/?linkid=2195682&clcid=0x409&culture=en-us&country=us",
    cacheFileName: "Windows11EnterpriseEvaluation.iso",
    required: true,
    profiles: ["windows11-enterprise-eval"],
  },
  {
    kind: "windowsIso",
    name: "Windows Server 2025 Evaluation ISO",
    url: "https://go.microsoft.com/fwlink/?linkid=2345730&clcid=0x409&culture=en-us&country=us",
    cacheFileName: "WindowsServer2025Evaluation.iso",
    required: true,
    profiles: ["windows-server-2025-eval"],
  },
  {
    kind: "virtioIso",
    name: "stable virtio-win ISO",
    url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso",
    cacheFileName: "virtio-win-stable.iso",
    required: true,
    profiles: ["windows11-enterprise-eval", "windows-server-2025-eval"],
  },
  {
    kind: "driverBundle",
    name: "latest virtio-win guest tools",
    url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-virtio/virtio-win-guest-tools.exe",
    cacheFileName: "virtio-win-guest-tools.exe",
    required: false,
    profiles: ["windows11-enterprise-eval", "windows-server-2025-eval"],
  },
];

export const MANUAL_DOWNLOADS: readonly ManualDownload[] = [
  {
    kind: "windowsIso",
    name: "Windows 11 Enterprise Evaluation page",
    url: "https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise",
    cacheFileName: "Windows11EnterpriseEvaluation.iso",
  },
  {
    kind: "windowsIso",
    name: "Windows 11 Enterprise Evaluation ISO fwlink",
    url: "https://go.microsoft.com/fwlink/p/?linkid=2195682&clcid=0x409&culture=en-us&country=us",
    cacheFileName: "Windows11EnterpriseEvaluation.iso",
  },
  {
    kind: "windowsIso",
    name: "Windows Server 2025 Evaluation page",
    url: "https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2025",
    cacheFileName: "WindowsServer2025Evaluation.iso",
  },
  {
    kind: "windowsIso",
    name: "Windows Server 2025 Evaluation ISO fwlink",
    url: "https://go.microsoft.com/fwlink/?linkid=2345730&clcid=0x409&culture=en-us&country=us",
    cacheFileName: "WindowsServer2025Evaluation.iso",
  },
  {
    kind: "virtioIso",
    name: "stable virtio-win ISO",
    url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso",
    cacheFileName: "virtio-win-stable.iso",
  },
  {
    kind: "virtioIso",
    name: "latest virtio-win ISO",
    url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-virtio/virtio-win.iso",
    cacheFileName: "virtio-win-latest.iso",
  },
  {
    kind: "driverBundle",
    name: "latest virtio-win guest tools",
    url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-virtio/virtio-win-guest-tools.exe",
    cacheFileName: "virtio-win-guest-tools.exe",
  },
];

export function buildMediaCachePlan(config: Partial<MediaCacheConfig> = {}): MediaCachePlan {
  const cacheDirectory = config.cacheDir ?? DEFAULT_MEDIA_CACHE_DIR;
  const profile = config.profile ?? "windows11-enterprise-eval";
  const sources = DEFAULT_MEDIA_SOURCES.filter((source) => source.profiles.includes(profile));

  return {
    cacheDirectory,
    profile,
    entries: sources.map((source) => applyMediaOverride(source, cacheDirectory, config)),
    manualDownloads: getManualDownloadsForSources(sources),
  };
}

export function getManualDownloadInstructions(
  cacheDir = DEFAULT_MEDIA_CACHE_DIR,
  downloads: readonly ManualDownload[] = MANUAL_DOWNLOADS,
): string {
  const lines = downloads.map(
    (download) =>
      `- ${download.name}: ${download.url} -> ${path.join(cacheDir, download.cacheFileName)}`,
  );

  return [
    "If automated media downloads are blocked, manually download the needed files:",
    ...lines,
    "Custom paths can be supplied in crucible.config.json.",
  ].join("\n");
}

function getManualDownloadsForSources(
  sources: readonly DefaultMediaSource[],
): readonly ManualDownload[] {
  const cacheFileNames = new Set(sources.map((source) => source.cacheFileName));

  return MANUAL_DOWNLOADS.filter((download) => cacheFileNames.has(download.cacheFileName));
}

function applyMediaOverride(
  source: DefaultMediaSource,
  cacheDirectory: string,
  config: Partial<MediaCacheConfig>,
): MediaCacheEntry {
  const override = getOverrideForKind(source.kind, config);

  return {
    kind: source.kind,
    name: source.name,
    sourceUrl: override?.url ?? source.url,
    overridePath: override?.path,
    cachePath: override?.path ?? path.join(cacheDirectory, source.cacheFileName),
    sha256: override?.sha256 ?? source.sha256,
    required: source.required,
    manualUrl: source.url,
  };
}

function getOverrideForKind(
  kind: MediaKind,
  config: Partial<MediaCacheConfig>,
): MediaOverride | undefined {
  switch (kind) {
    case "windowsIso":
      return config.windowsIso;
    case "virtioIso":
      return config.virtioIso;
    case "driverBundle":
      return config.driverBundle;
  }
}
