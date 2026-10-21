import {
  CHALLENGE_MAX_EPISODES_PER_TASK,
  parseChallengeEpisode,
  type ChallengeEpisode,
} from "./challenge";

/** One chrome.storage.session key holding `Record<task_id, ChallengeEpisode[]>`. */
export const CHALLENGE_STORAGE_KEY = "agenttab.challenges.v1";

type EpisodeTable = Record<string, ChallengeEpisode[]>;

// Every mutation runs through this chain so concurrent scans never lose each other's writes.
let chain: Promise<unknown> = Promise.resolve();

export function challengeStoreAvailable(): boolean {
  return typeof chrome !== "undefined" && chrome.storage?.session !== undefined;
}

function parseTable(raw: unknown): EpisodeTable {
  const table: EpisodeTable = Object.create(null);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return table;
  for (const [taskId, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const episodes = value
      .map(parseChallengeEpisode)
      .filter((episode): episode is ChallengeEpisode => episode !== undefined && episode.task_id === taskId);
    if (episodes.length > 0) table[taskId] = episodes.slice(-CHALLENGE_MAX_EPISODES_PER_TASK);
  }
  return table;
}

async function readTable(): Promise<EpisodeTable> {
  const stored = await chrome.storage.session.get(CHALLENGE_STORAGE_KEY);
  return parseTable(stored[CHALLENGE_STORAGE_KEY]);
}

async function writeTable(table: EpisodeTable): Promise<void> {
  await chrome.storage.session.set({ [CHALLENGE_STORAGE_KEY]: table });
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const run = chain.then(operation, operation);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Applies `step` to a task's episodes and persists the result atomically with respect to
 * other store operations. `step` returns the replacement list and any value for the caller.
 */
export function updateTaskEpisodes<T extends { episodes: ChallengeEpisode[] }>(
  taskId: string,
  step: (episodes: ChallengeEpisode[]) => T,
): Promise<T> {
  return serialized(async () => {
    const table = await readTable();
    const result = step(table[taskId] ?? []);
    if (result.episodes.length > 0) table[taskId] = result.episodes;
    else delete table[taskId];
    await writeTable(table);
    return result;
  });
}

export function readTaskEpisodes(taskId: string): Promise<ChallengeEpisode[]> {
  return serialized(async () => (await readTable())[taskId] ?? []);
}

/**
 * Binds an attention notice to a task's episode, so every later event of that episode carries `notice_id`.
 * Returns false when the task no longer holds the episode.
 */
export async function bindChallengeNotice(taskId: string, challengeId: string, noticeId: string): Promise<boolean> {
  const { bound } = await updateTaskEpisodes(taskId, (episodes) => {
    let found = false;
    const next = episodes.map((episode) => {
      if (episode.challenge_id !== challengeId) return episode;
      found = true;
      return { ...episode, notice_id: noticeId };
    });
    return { episodes: next, bound: found };
  });
  return bound;
}

/** Deletes every episode of a task. A no-op when the store is unavailable or the task has none. */
export function clearChallengeTask(taskId: string): Promise<void> {
  if (!challengeStoreAvailable()) return Promise.resolve();
  return serialized(async () => {
    const table = await readTable();
    if (!(taskId in table)) return;
    delete table[taskId];
    await writeTable(table);
  });
}
