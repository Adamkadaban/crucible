import { createHash } from "node:crypto";

import { z } from "zod";

const WINDOWS_ACCOUNT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
const WINDOWS_HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,13}[A-Za-z0-9])?$/;

const realismProfileSchema = z.enum([
  "minimal",
  "office-user",
  "developer",
  "student",
  "home-user",
]);

export const realismConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    seed: z.string().min(1).optional(),
    profile: realismProfileSchema.default("office-user"),
    hostname: z.string().regex(WINDOWS_HOSTNAME).optional(),
    adminUsername: z.string().regex(WINDOWS_ACCOUNT_NAME).optional(),
    userUsername: z.string().regex(WINDOWS_ACCOUNT_NAME).optional(),
    fullName: z.string().min(1).optional(),
    locale: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    keyboardLayout: z.string().min(1).optional(),
    screenResolution: z
      .string()
      .regex(/^\d{3,5}x\d{3,5}$/)
      .describe("Persona metadata only; display settings are not applied in the guest yet.")
      .optional(),
    installCommonSoftware: z.boolean().default(false),
    populateUserFiles: z.boolean().default(true),
    simulateUserHistory: z.boolean().default(false),
    randomizeInstallTimes: z.boolean().default(true),
  })
  .strict();

export type RealismConfig = z.output<typeof realismConfigSchema>;
export type RealismProfileName = z.output<typeof realismProfileSchema>;

export type RealismDecoyFile = {
  readonly relativePath: string;
  readonly content: string;
  readonly lastWriteTimeUtc: string;
  readonly category: "ordinary-user" | "inert-secret";
};

export type RealismSoftwareMarker = {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly installDate: string;
};

export type RealismPersona = {
  readonly schemaVersion: 1;
  readonly enabled: true;
  readonly seed: string;
  readonly profile: RealismProfileName;
  readonly hostname: string;
  readonly adminUsername: string;
  readonly userUsername: string;
  readonly fullName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly keyboardLayout: string;
  readonly screenResolution: string;
  readonly installCommonSoftware: boolean;
  readonly populateUserFiles: boolean;
  readonly simulateUserHistory: boolean;
  readonly randomizeInstallTimes: boolean;
  readonly decoyFiles: readonly RealismDecoyFile[];
  readonly softwareMarkers: readonly RealismSoftwareMarker[];
};

const FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery"];
const LAST_NAMES = ["Brooks", "Carter", "Hayes", "Miller", "Parker", "Reed", "Sullivan", "Turner"];
const LOCALES = ["en-US", "en-GB", "en-CA", "en-AU"];
const TIMEZONES = [
  "Pacific Standard Time",
  "Mountain Standard Time",
  "Central Standard Time",
  "Eastern Standard Time",
];
const RESOLUTIONS = ["1366x768", "1440x900", "1600x900", "1920x1080", "2560x1440"];
const HOST_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function buildRealismPersona(options: {
  readonly vmName: string;
  readonly config: RealismConfig;
}): RealismPersona | undefined {
  if (!options.config.enabled) {
    return undefined;
  }

  const seed = options.config.seed ?? `${options.vmName}:${options.config.profile}`;
  const firstName = pick(seed, "first-name", FIRST_NAMES);
  const lastName = pick(seed, "last-name", LAST_NAMES);
  const userUsername =
    options.config.userUsername ?? accountName(`${firstName}${lastName[0] ?? ""}`);
  const adminUsername =
    options.config.adminUsername ?? accountName(`admin${token(seed, "admin", 4).toLowerCase()}`);
  const fullName = options.config.fullName ?? `${firstName} ${lastName}`;
  const locale = options.config.locale ?? pick(seed, "locale", LOCALES);
  const keyboardLayout = options.config.keyboardLayout ?? locale;
  const persona = {
    schemaVersion: 1 as const,
    enabled: true as const,
    seed,
    profile: options.config.profile,
    hostname: options.config.hostname ?? `DESKTOP-${token(seed, "hostname", 7)}`,
    adminUsername,
    userUsername,
    fullName,
    locale,
    timezone: options.config.timezone ?? pick(seed, "timezone", TIMEZONES),
    keyboardLayout,
    screenResolution: options.config.screenResolution ?? pick(seed, "resolution", RESOLUTIONS),
    installCommonSoftware: options.config.installCommonSoftware,
    populateUserFiles: options.config.populateUserFiles,
    simulateUserHistory: options.config.simulateUserHistory,
    randomizeInstallTimes: options.config.randomizeInstallTimes,
    decoyFiles: [] as readonly RealismDecoyFile[],
    softwareMarkers: [] as readonly RealismSoftwareMarker[],
  };

  return {
    ...persona,
    decoyFiles: buildRealismDecoyFilePlan(persona),
    softwareMarkers: buildRealismSoftwareMarkers(persona),
  };
}

export function buildRealismDecoyFilePlan(
  persona: Omit<RealismPersona, "decoyFiles" | "softwareMarkers">,
): readonly RealismDecoyFile[] {
  if (!persona.populateUserFiles) {
    return [];
  }

  const profileFiles: Record<RealismProfileName, readonly string[]> = {
    minimal: [
      "Desktop\\notes.txt",
      "Documents\\notes.txt",
      "Downloads\\readme.txt",
      "Pictures\\wallpaper-ideas.txt",
      "Videos\\clips-to-watch.txt",
    ],
    "office-user": [
      "Desktop\\Q3 planning.url",
      "Documents\\Quarterly notes.txt",
      "Documents\\Project tracker.csv",
      "Documents\\HR\\benefits-notes.txt",
      "Pictures\\whiteboard\\roadmap.txt",
      "Videos\\training\\onboarding-notes.txt",
      "Downloads\\invoice-summary.txt",
      "Music\\focus-playlist.m3u",
    ],
    developer: [
      "Desktop\\Local tools.url",
      "Documents\\dev-notes.txt",
      "Documents\\repos.txt",
      "Documents\\architecture\\todo.md",
      "Pictures\\screenshots\\bug-repro.txt",
      "Videos\\demos\\recording-notes.txt",
      "Downloads\\release-checklist.txt",
      "Music\\coding-playlist.m3u",
    ],
    student: [
      "Desktop\\Campus portal.url",
      "Documents\\class-notes.txt",
      "Documents\\reading-list.txt",
      "Documents\\assignments\\draft-outline.txt",
      "Pictures\\lecture-board\\week-4.txt",
      "Videos\\lectures\\watch-later.txt",
      "Downloads\\assignment-outline.txt",
      "Music\\study-playlist.m3u",
    ],
    "home-user": [
      "Desktop\\Recipes.url",
      "Documents\\household-list.txt",
      "Pictures\\vacation-notes.txt",
      "Pictures\\family\\print-list.txt",
      "Videos\\phone-import\\favorites.txt",
      "Downloads\\warranty-info.txt",
      "Music\\roadtrip-playlist.m3u",
    ],
  };

  const inertSecretFiles = persona.simulateUserHistory
    ? [
        "Desktop\\passwords-old.txt",
        "Documents\\Personal\\accounts.txt",
        "Documents\\Taxes\\id-notes.txt",
        "Downloads\\backup-codes.txt",
        "AppData\\Roaming\\FileZilla\\sitemanager.xml",
        "AppData\\Roaming\\Microsoft\\Credentials\\readme.txt",
        ".ssh\\config",
        ".ssh\\id_rsa",
        ".aws\\credentials",
        "AppData\\Roaming\\Exodus\\exodus.wallet\\seed.txt",
      ]
    : [];

  const randomizedOrdinaryFiles = Array.from(
    { length: persona.profile === "minimal" ? 4 : 10 },
    (_, index) => randomizedUserFilePath(persona.seed, index),
  );
  const ordinaryPaths = [...profileFiles[persona.profile], ...randomizedOrdinaryFiles];
  const ordinary = ordinaryPaths.map((relativePath, index) => ({
    relativePath,
    content: decoyContent(persona, relativePath),
    lastWriteTimeUtc: personaTimestamp(persona, `file-${index}`),
    category: "ordinary-user" as const,
  }));
  const secrets = inertSecretFiles.map((relativePath, index) => ({
    relativePath,
    content: inertSecretContent(persona, relativePath, index),
    lastWriteTimeUtc: personaTimestamp(persona, `secret-${index}`),
    category: "inert-secret" as const,
  }));

  return [...ordinary, ...secrets];
}

function randomizedUserFilePath(seed: string, index: number): string {
  const folders = [
    "Desktop",
    "Documents",
    "Documents\\Archive",
    "Downloads",
    "Pictures",
    "Pictures\\Camera Roll",
    "Videos",
    "Music",
  ];
  const basenames = [
    "notes",
    "todo",
    "receipt",
    "scan",
    "meeting",
    "draft",
    "photo-list",
    "backup",
    "ideas",
    "schedule",
  ];
  const extensions = ["txt", "csv", "md", "url"];
  const folder = pick(seed, `random-file-folder-${index}`, folders);
  const basename = pick(seed, `random-file-name-${index}`, basenames);
  const extension = pick(seed, `random-file-ext-${index}`, extensions);
  return `${folder}\\${basename}-${token(seed, `random-file-token-${index}`, 4).toLowerCase()}.${extension}`;
}

export function buildRealismSoftwareMarkers(
  persona: Omit<RealismPersona, "decoyFiles" | "softwareMarkers">,
): readonly RealismSoftwareMarker[] {
  if (!persona.installCommonSoftware) {
    return [];
  }

  const base = [
    { name: "Google Chrome", publisher: "Google LLC" },
    { name: "Mozilla Firefox", publisher: "Mozilla" },
    { name: "7-Zip", publisher: "Igor Pavlov" },
    { name: "Notepad++", publisher: "Notepad++ Team" },
    { name: "Adobe Acrobat Reader", publisher: "Adobe" },
    { name: "VLC media player", publisher: "VideoLAN" },
  ];
  const profileSpecific: Record<
    RealismProfileName,
    readonly { name: string; publisher: string }[]
  > = {
    minimal: [],
    "office-user": [
      { name: "Microsoft Teams", publisher: "Microsoft Corporation" },
      { name: "LibreOffice", publisher: "The Document Foundation" },
    ],
    developer: [
      { name: "Visual Studio Code", publisher: "Microsoft Corporation" },
      { name: "Git", publisher: "The Git Development Community" },
    ],
    student: [
      { name: "Zoom Workplace", publisher: "Zoom Video Communications, Inc." },
      { name: "LibreOffice", publisher: "The Document Foundation" },
    ],
    "home-user": [
      { name: "Spotify", publisher: "Spotify AB" },
      { name: "iCloud", publisher: "Apple Inc." },
    ],
  };

  return [...base, ...profileSpecific[persona.profile]].map((entry, index) => ({
    ...entry,
    version: `${1 + numberFromSeed(persona.seed, `software-${index}-major`, 120)}.${numberFromSeed(persona.seed, `software-${index}-minor`, 20)}.${numberFromSeed(persona.seed, `software-${index}-patch`, 5000)}`,
    installDate: personaInstallDate(persona, `software-${index}`),
  }));
}

function pick<T>(seed: string, label: string, values: readonly T[]): T {
  return values[numberFromSeed(seed, label, values.length)]!;
}

function token(seed: string, label: string, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += HOST_ALPHABET[numberFromSeed(seed, `${label}-${index}`, HOST_ALPHABET.length)] ?? "A";
  }
  return value;
}

function accountName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "User";
}

function numberFromSeed(seed: string, label: string, modulo: number): number {
  const digest = createHash("sha256").update(seed).update(":").update(label).digest();
  return digest.readUInt32BE(0) % modulo;
}

function seededTimestamp(seed: string, label: string): string {
  const day = 1 + numberFromSeed(seed, `${label}-day`, 300);
  const minute = numberFromSeed(seed, `${label}-minute`, 24 * 60);
  return new Date(Date.UTC(2025, 0, day, Math.floor(minute / 60), minute % 60, 0)).toISOString();
}

function personaTimestamp(
  persona: Omit<RealismPersona, "decoyFiles" | "softwareMarkers">,
  label: string,
): string {
  return persona.randomizeInstallTimes
    ? seededTimestamp(persona.seed, label)
    : "2025-01-01T12:00:00.000Z";
}

function seededInstallDate(seed: string, label: string): string {
  return seededTimestamp(seed, label).slice(0, 10).replaceAll("-", "");
}

function personaInstallDate(
  persona: Omit<RealismPersona, "decoyFiles" | "softwareMarkers">,
  label: string,
): string {
  return persona.randomizeInstallTimes ? seededInstallDate(persona.seed, label) : "20250101";
}

function decoyContent(
  persona: Omit<RealismPersona, "decoyFiles" | "softwareMarkers">,
  relativePath: string,
): string {
  return [
    `${relativePath}`,
    `Owner: ${persona.fullName}`,
    `Profile: ${persona.profile}`,
    "This benign file was generated by Crucible realism provisioning.",
    "Do not put real personal data, credentials, or operator files in realism sources.",
    "",
  ].join("\r\n");
}

function inertSecretContent(
  persona: Omit<RealismPersona, "decoyFiles" | "softwareMarkers">,
  relativePath: string,
  index: number,
): string {
  const marker = token(persona.seed, `honeytoken-${index}`, 18);
  if (relativePath.endsWith("id_rsa")) {
    return [
      "CRUCIBLE-INERT-OPENSSH-PRIVATE-KEY",
      `CRUCIBLE-INERT-HONEYTOKEN-${marker}`,
      "THIS IS NOT A VALID PRIVATE KEY",
      "",
    ].join("\r\n");
  }
  if (relativePath.endsWith(".aws\\credentials")) {
    return [
      "[default]",
      `aws_access_key_id = CRUCIBLEINERT${marker}`,
      `aws_secret_access_key = not-a-real-secret-${marker.toLowerCase()}`,
      "",
    ].join("\r\n");
  }
  if (relativePath.endsWith("sitemanager.xml")) {
    return `<FileZilla3><Servers><Server><Host>inert-${marker.toLowerCase()}.example.invalid</Host><User>${persona.userUsername}</User><Pass encoding="base64">Q1JVQ0lCTEVfSU5FUlQ=</Pass></Server></Servers></FileZilla3>\r\n`;
  }

  return [
    `Owner: ${persona.fullName}`,
    `Honeytoken: CRUCIBLE-INERT-${marker}`,
    "These values are intentionally fake decoys for malware-analysis realism.",
    "They are not credentials and must not be replaced with real secrets.",
    "",
  ].join("\r\n");
}
