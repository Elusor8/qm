import { posix } from "node:path";
import { shq } from "../util/shell.ts";

export const BASE_RESIDENT_AUTH_PATHS = [
  ".aws",
  ".config/gh",
  ".config/gcloud",
  ".ssh",
  ".netrc",
  ".git-credentials",
] as const;

export const BASE_EPHEMERAL_CRED_LINKS: ReadonlyArray<{ rel: string; kind: "dir" | "file" }> = [
  { rel: ".aws", kind: "dir" },
  { rel: ".netrc", kind: "file" },
  { rel: ".config/gh", kind: "dir" },
  { rel: ".config/glab", kind: "dir" },
  { rel: ".config/gcloud", kind: "dir" },
];

const DURABLE_CREDENTIAL_PATHS = [".ssh", ".git-credentials"] as const;
export const EPHEMERAL_CRED_DIR = "/tmp/agent-creds";

// Prep runs before every command under a wall-clock timeout, and EPHEMERAL_CRED_DIR sits on a
// different device from $HOME — so `mv $HOME/x /tmp/agent-creds/x` is a recursive copy whose
// duration scales with the bundle, not a rename. A copy that outruns the timeout is retried from
// scratch on the next command and never converges. Displaced $HOME state is therefore renamed
// aside on its own device (atomic, O(1)) and the keychain refills the ephemeral target.
//
// Asides land under a single quarantine root rather than beside what they displaced: a
// `~/.config/gcloud.displaced` sitting in the open would be scanned as a credential service named
// `gcloud.displaced` and would slip past the backup exclude's prefix match, putting the very
// plaintext credentials this module keeps out of $HOME back into backups and published apps.
export const DISPLACED_DIR_REL = ".agent-displaced";

export interface CredentialPathSpec {
  path: string;
  kind: "file" | "directory";
}

export function residentAuthPaths(extra: readonly CredentialPathSpec[] = []): string[] {
  return [...new Set([...BASE_RESIDENT_AUTH_PATHS, ...extra.map((entry) => entry.path)])];
}

export function credentialServiceForPath(path: string): string | undefined {
  const normalized = path.replace(/^\.\//, "");
  if (normalized.startsWith(".config/")) return normalized.split("/")[1] || undefined;
  const first = normalized.split("/")[0] ?? "";
  return first.startsWith(".") && first.length > 1 ? first.slice(1) : undefined;
}

export function ephemeralCredLinkPaths(
  extra: readonly CredentialPathSpec[] = [],
): Array<{ rel: string; kind: "dir" | "file" }> {
  const links = new Map<string, "dir" | "file">(BASE_EPHEMERAL_CRED_LINKS.map(({ rel, kind }) => [rel, kind]));
  const covered = (path: string): boolean =>
    DURABLE_CREDENTIAL_PATHS.some((base) => path === base || path.startsWith(`${base}/`)) ||
    BASE_EPHEMERAL_CRED_LINKS.some(({ rel }) => path === rel || path.startsWith(`${rel}/`));
  for (const { path, kind } of extra) {
    if (covered(path)) continue;
    if (!links.has(path)) links.set(path, kind === "directory" ? "dir" : "file");
  }
  return [...links].map(([rel, kind]) => ({ rel, kind }));
}

// A stale non-directory must not deny the agent its computer, so the mkdir heals itself. Clearing
// only on the failure (rather than testing first) keeps the destructive branch off the healthy path
// and leaves no window between the test and the create — and `rm -rf` is sound here because
// EPHEMERAL_CRED_DIR holds nothing the keychain cannot re-materialize. It is NOT sound on a $HOME
// path, where the same line deleted the agent's entire home directory; those go through
// mkdirDisplacing instead.
const mkdirHealing = (dir: string): string => {
  if (dir !== EPHEMERAL_CRED_DIR && !dir.startsWith(`${EPHEMERAL_CRED_DIR}/`))
    throw new Error(`refusing destructive mkdir healing outside ${EPHEMERAL_CRED_DIR}: ${dir}`);
  return `if ! mkdir -p ${shq(dir)} 2>/dev/null; then rm -rf ${shq(dir)}; mkdir -p ${shq(dir)}; fi`;
};

// Nothing prunes $HOME on the agent's behalf, and prep runs before every command: a CLI that
// recreates its config directory each turn would otherwise leave an aside per turn until the disk
// fills. Quarantine is a grace period for recovering a displaced login, not an archive.
const QUARANTINE_RETENTION_DAYS = 7;

// The quarantine root has nowhere inside itself to go, so it heals in place — and the test must not
// follow symlinks. A symlink here is accepted by `[ -d ]` and every later `mv` writes THROUGH it,
// walking plaintext credentials out of the one directory the backup prune and the capture glob
// know to skip. The agent has a shell, so that is reachable, not theoretical.
const healQuarantine = (dir: string): string =>
  `if [ ! -d ${dir} ] || [ -L ${dir} ]; then if [ -e ${dir} ] || [ -L ${dir} ]; then mv ${dir} ${dir}.$$.$(date +%s); fi; mkdir -p ${dir}; fi`;

// Move a $HOME path into the quarantine root. Everything here — healing the root included — sits on
// the displacement path rather than running up front, so a converged box writes nothing to $HOME
// before a command and cannot be denied its computer by a full or read-only disk it could
// otherwise still be used to clear.
const displace = (home: string, rel: string): string => {
  const quarantine = posix.join(home, DISPLACED_DIR_REL);
  const aside = posix.join(quarantine, rel);
  const src = posix.join(home, rel);
  // `$$` alone is not unique over a box's lifetime — PID space is small and reused, and `mv`
  // clobbers a same-named file without complaint, which would silently delete an older bundle.
  return [
    healQuarantine(shq(quarantine)),
    `find ${shq(quarantine)} -mindepth 1 -maxdepth 1 -mtime +${QUARANTINE_RETENTION_DAYS} -exec rm -rf {} + 2>/dev/null`,
    `mkdir -p ${shq(posix.dirname(aside))}`,
    // Concurrent preps both reach here; the loser finds the source already taken, which is the
    // outcome it wanted. Any other mv failure still stops the chain with its stderr intact.
    `mv ${shq(src)} ${shq(aside)}.$$.$(date +%s) || [ ! -e ${shq(src)} ]`,
  ].join("; ");
};

// Two concurrent preps both pass the `[ ! -L ]` guard, so the loser's bare `ln -s` fails EEXIST and
// kills the && chain. Losing the race is not an error when the winner produced the link we wanted;
// anything else on the path still fails loudly. (`ln -sfn` is not portable enough to rely on: BSD
// ln rejects it against an existing symlink-to-directory.)
const linkOrConverge = (path: string, target: string): string =>
  `ln -s ${shq(target)} ${shq(path)} || [ "$(readlink ${shq(path)} 2>/dev/null)" = ${shq(target)} ]`;

// The $HOME counterpart of mkdirHealing. A failed mkdir after displacement fails the chain loudly
// rather than reaching for rm -rf: denying one turn beats destroying the box's home directory.
const mkdirDisplacing = (home: string, rel: string): string => {
  if (rel === ".") return `mkdir -p ${shq(home)}`;
  const dir = shq(posix.join(home, rel));
  return `if [ ! -d ${dir} ]; then if [ -e ${dir} ] || [ -L ${dir} ]; then ${displace(home, rel)}; fi; mkdir -p ${dir}; fi`;
};

export function ephemeralCredLinkScript(home: string, extraPaths: readonly CredentialPathSpec[] = []): string {
  const parts = [mkdirHealing(EPHEMERAL_CRED_DIR), `chmod 700 ${shq(EPHEMERAL_CRED_DIR)}`];
  for (const { rel, kind } of ephemeralCredLinkPaths(extraPaths)) {
    const path = posix.join(home, rel);
    const target = posix.join(EPHEMERAL_CRED_DIR, rel);
    parts.push(
      mkdirHealing(posix.dirname(target)),
      // A symlink pointing somewhere stale is dropped, not followed: migrating what it pointed at
      // was the cross-device copy this prep can no longer afford. The bundle stays where it is and
      // the keychain refills the ephemeral target.
      `if [ -L ${shq(path)} ] && [ "$(readlink ${shq(path)})" != ${shq(target)} ]; then rm -f ${shq(path)}; fi`,
      `if [ ! -L ${shq(path)} ]; then if [ -e ${shq(path)} ]; then ${displace(home, rel)}; fi; ${mkdirDisplacing(home, posix.dirname(rel))}; ${linkOrConverge(path, target)}; fi`,
    );
    if (kind === "dir") parts.push(mkdirHealing(target));
  }
  return parts.join(" && ");
}

export const EPHEMERAL_CRED_PATHS: ReadonlyArray<{ rel: string; kind: "dir" | "file" }> = ephemeralCredLinkPaths();
