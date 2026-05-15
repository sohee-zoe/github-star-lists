#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRESETS_DIR = resolve(PACKAGE_ROOT, "presets");
const DEFAULT_PRESET = "general";
const DEFAULT_CONFIG_PATH = resolve(PRESETS_DIR, `${DEFAULT_PRESET}.json`);

const command = process.argv[2]?.startsWith("-") ? null : process.argv[2];
const args = new Set(process.argv.slice(2));
const configPath = resolveOption("--config") ?? findDefaultConfigPath();
const outDir = resolve(process.cwd(), resolveOption("--out-dir") ?? "out");
const apply = args.has("--apply");
const verbose = args.has("--verbose");
const quiet = args.has("--quiet");
const existingOnly = args.has("--existing-only");
const syncListDescriptions = args.has("--sync-list-descriptions");
const syncListVisibility = args.has("--sync-list-visibility");
const overwriteListDescriptions = args.has("--overwrite-list-descriptions");
const onlyListDescriptions = args.has("--only-list-descriptions");
const onlyListMetadata = args.has("--only-list-metadata") || onlyListDescriptions;
const allPrivate = args.has("--all-private");
const allPublic = args.has("--all-public");
const yes = args.has("--yes") || args.has("-y");
const limitOption = resolveOption("--limit");
const limit = limitOption ? Number(limitOption) : Infinity;
let authToken = null;

if (args.has("--help") || args.has("-h")) {
  printHelp();
  process.exit(0);
}

if (command === "init") {
  await initConfig();
  process.exit(0);
}

if (command === "suggest-config") {
  await suggestConfig();
  process.exit(0);
}

if (command === "wizard") {
  const status = await runWizard();
  process.exit(status);
}

if (command && !["run", "wizard", "suggest-config"].includes(command)) {
  fail(`Unknown command: ${command}\nRun with --help for usage.`);
}

if (Number.isNaN(limit) || limit <= 0) {
  fail("--limit must be a positive number");
}

if (allPrivate && allPublic) {
  fail("Choose only one of --all-private or --all-public.");
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const settings = {
  defaultPrivate: false,
  minScore: 2,
  maxListsPerRepo: 3,
  preserveExistingAssignments: true,
  readmeFallback: true,
  readmeMaxChars: 20000,
  readmeIgnoredKeywords: [
    "api", "app", "cd", "ci", "css", "data", "image", "prompt", "server",
    "tool", "ui", "video", "workflow"
  ],
  ...config.settings
};

function resolveOption(name) {
  const equalsArg = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (equalsArg) return equalsArg.slice(name.length + 1);

  const index = process.argv.indexOf(name);
  if (index !== -1) return process.argv[index + 1];
  return null;
}

function findDefaultConfigPath() {
  const candidates = [
    resolve(process.cwd(), "star-lists.config.json"),
    resolve(process.cwd(), "config/star-lists.json"),
    DEFAULT_CONFIG_PATH
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? DEFAULT_CONFIG_PATH;
}

async function initConfig() {
  if (args.has("--list-presets")) {
    console.log(listPresets().join("\n"));
    return;
  }

  const target = resolve(process.cwd(), resolveOption("--config") ?? "star-lists.config.json");
  if (existsSync(target) && !args.has("--force")) {
    fail(`${target} already exists. Re-run init with --force to overwrite it.`);
  }

  if (args.has("--from-existing-lists")) {
    await initFromExistingLists(target);
    return;
  }

  const preset = resolveOption("--preset") ?? DEFAULT_PRESET;
  writeFileSync(target, `${JSON.stringify(readPresetConfig(preset), null, 2)}\n`);
  console.log(`Wrote ${target} from preset "${preset}"`);
}

function listPresets() {
  return readdirSync(PRESETS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort((a, b) => a.localeCompare(b));
}

function readPresetConfig(preset) {
  const available = listPresets();
  if (!available.includes(preset)) {
    fail(`Unknown preset: ${preset}\nAvailable presets: ${available.join(", ")}`);
  }
  return JSON.parse(readFileSync(resolve(PRESETS_DIR, `${preset}.json`), "utf8"));
}

async function runWizard() {
  if (!process.stdin.isTTY) {
    fail("Wizard requires an interactive terminal. Use flags directly in non-interactive environments.");
  }

  const rl = createInterface({ input, output });
  try {
    console.log("GitHub Star Lists setup");
    console.log("");

    const mode = await promptChoice(rl, "What do you want to do?", [
      ["preview", "Preview a plan only"],
      ["apply", "Apply star list changes"],
      ["metadata", "Only sync list descriptions/visibility"]
    ], "preview");

    const visibility = await promptChoice(rl, "New list visibility?", [
      ["public", "Public"],
      ["private", "Private"],
      ["config", "Use config per list"]
    ], "public");

    const generatedArgs = [];
    appendPassthroughOption(generatedArgs, "--config");
    appendPassthroughOption(generatedArgs, "--out-dir");

    if (mode === "apply" || mode === "metadata") generatedArgs.push("--apply");
    if (mode === "metadata") generatedArgs.push("--only-list-metadata");

    if (visibility === "public") generatedArgs.push("--all-public");
    if (visibility === "private") generatedArgs.push("--all-private");

    const useExistingOnly = mode !== "metadata" &&
      await promptYesNo(rl, "Use existing lists only?", false);
    if (useExistingOnly) generatedArgs.push("--existing-only");

    const syncDescriptions = await promptYesNo(rl, "Fill empty list descriptions from config?", true);
    if (syncDescriptions) generatedArgs.push("--sync-list-descriptions");

    const syncVisibility = await promptYesNo(rl, "Also sync existing list visibility?", false);
    if (syncVisibility) generatedArgs.push("--sync-list-visibility");

    if (mode !== "metadata") {
      const limitValue = await promptText(rl, "Limit to newest N stars? Leave blank for all", "");
      if (limitValue.trim()) generatedArgs.push(`--limit=${limitValue.trim()}`);
    }

    if (args.has("--verbose")) generatedArgs.push("--verbose");
    if (args.has("--quiet")) generatedArgs.push("--quiet");

    console.log("");
    console.log("Checklist:");
    console.log(`  [x] Mode: ${mode === "preview" ? "preview only" : mode === "apply" ? "apply changes" : "metadata only"}`);
    console.log(`  [x] New list visibility: ${visibility}`);
    console.log(`  [${useExistingOnly ? "x" : " "}] Existing lists only`);
    console.log(`  [${syncDescriptions ? "x" : " "}] Sync descriptions`);
    console.log(`  [${syncVisibility ? "x" : " "}] Sync existing visibility`);
    console.log("");
    console.log(`Command: github-star-lists ${generatedArgs.join(" ") || "(preview)"}`);
    console.log("");

    const shouldRun = await promptYesNo(rl, "Run this now?", true);
    if (!shouldRun) return 0;

    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, [scriptPath, ...generatedArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit"
    });
    return child.status ?? 1;
  } finally {
    rl.close();
  }
}

function appendPassthroughOption(targetArgs, name) {
  const value = resolveOption(name);
  if (!value) return;
  targetArgs.push(name, value);
}

async function promptChoice(rl, question, choices, defaultValue) {
  const defaultIndex = choices.findIndex(([value]) => value === defaultValue);
  const fallbackIndex = defaultIndex === -1 ? 0 : defaultIndex;

  console.log(question);
  choices.forEach(([, label], index) => {
    const checked = index === fallbackIndex ? "x" : " ";
    console.log(`  ${index + 1}. [${checked}] ${label}`);
  });

  const answer = await rl.question(`Choose 1-${choices.length} [${fallbackIndex + 1}]: `);
  const selected = Number(answer.trim() || String(fallbackIndex + 1));
  if (!Number.isInteger(selected) || selected < 1 || selected > choices.length) {
    console.log("");
    console.log(`Using default: ${choices[fallbackIndex][1]}`);
    console.log("");
    return choices[fallbackIndex][0];
  }
  console.log("");
  return choices[selected - 1][0];
}

async function promptYesNo(rl, question, defaultYes) {
  const answer = await rl.question(`${question} [${defaultYes ? "Y/n" : "y/N"}]: `);
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return defaultYes;
  return ["y", "yes"].includes(normalized);
}

async function promptText(rl, question, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer || defaultValue;
}

function getToken() {
  if (authToken) return authToken;

  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    authToken = envToken;
    return authToken;
  }

  try {
    authToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    return authToken;
  } catch {
    fail("No GitHub token found. Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`.");
  }
}

async function initFromExistingLists(target) {
  const progress = createProgress({ quiet });
  const viewer = await fetchViewerLists(progress);
  const lists = viewer.lists.nodes.map((list) => ({
    name: list.name,
    description: list.description ?? "",
    isPrivate: list.isPrivate,
    keywords: [],
    topics: suggestTopicsForListName(list.name)
  }));

  writeFileSync(target, `${JSON.stringify({
    settings: {
      defaultPrivate: false,
      minScore: 2,
      maxListsPerRepo: 3,
      preserveExistingAssignments: true
    },
    lists
  }, null, 2)}\n`);
  console.log(`Wrote ${target} from ${lists.length} existing GitHub Star Lists`);
}

async function suggestConfig() {
  if (Number.isNaN(limit) || limit <= 0) {
    fail("--limit must be a positive number");
  }

  const progress = createProgress({ quiet });
  const viewer = await fetchViewerLists(progress);
  const stars = await fetchStars(limit, progress);
  const stats = buildSuggestionStats(stars);
  const existingLists = viewer.lists.nodes;
  const lists = existingLists.length
    ? existingLists.map((list) => suggestListFromExisting(list, stats))
    : suggestListsFromStats(stats);

  mkdirSync(outDir, { recursive: true });
  const jsonPath = resolve(outDir, "suggested-config.json");
  writeFileSync(jsonPath, `${JSON.stringify({
    settings: {
      defaultPrivate: false,
      minScore: 2,
      maxListsPerRepo: 3,
      preserveExistingAssignments: true
    },
    lists,
    _meta: {
      generatedAt: new Date().toISOString(),
      starsScanned: stars.length,
      existingListsScanned: existingLists.length,
      topTopics: topEntries(stats.topics, 30),
      topLanguages: topEntries(stats.languages, 20),
      topDescriptionKeywords: topEntries(stats.descriptionKeywords, 40)
    }
  }, null, 2)}\n`);

  console.log(`Wrote ${jsonPath}`);
  console.log(`Scanned ${stars.length} starred repositories and ${existingLists.length} existing lists.`);
}

function resolveListPrivacy(listConfig) {
  if (allPrivate) return true;
  if (allPublic) return false;
  return listConfig.isPrivate ?? settings.defaultPrivate;
}

async function confirmListVisibility({ listsToCreate, listVisibilityUpdates }) {
  if (yes) return;
  console.log("");
  if (listsToCreate.length) {
    console.log("Lists to create:");
    for (const list of listsToCreate) {
      const mark = list.isPrivate ? "[x] private" : "[x] public";
      console.log(`  ${mark} ${list.name}`);
    }
  }
  if (listVisibilityUpdates.length) {
    if (listsToCreate.length) console.log("");
    console.log("Existing list visibility changes:");
    for (const update of listVisibilityUpdates) {
      const mark = update.isPrivate ? "[x] private" : "[x] public";
      console.log(`  ${mark} ${update.name} (${update.from} -> ${update.to})`);
    }
  }
  console.log("");
  console.log("Default visibility is public. Re-run with --all-private for private, or --all-public for public.");

  if (!process.stdin.isTTY) {
    fail("Confirmation required before changing list visibility. Re-run with --yes to skip this prompt.");
  }

  const rl = createInterface({ input, output });
  const answer = await rl.question("Continue with the visibility shown above? Type yes to continue: ");
  rl.close();

  if (answer.trim().toLowerCase() !== "yes") {
    fail("Aborted.");
  }
}

function printHelp() {
  console.log(`GitHub Star List Organizer

Usage:
  github-star-lists init [--preset general] [--config star-lists.config.json] [--force]
  github-star-lists init --from-existing-lists [--config star-lists.config.json] [--force]
  github-star-lists suggest-config [--limit=200] [--out-dir out]
  github-star-lists wizard
  github-star-lists [run] [options]

Options:
  --preset <name>                 Config preset for init. Default: general.
  --from-existing-lists           Build config from your current GitHub Star Lists.
  --list-presets                  Print available preset names.
  --apply                         Apply changes to GitHub. Without this, only writes a plan.
  --config <path>                 Classification config path.
  --out-dir <path>                Plan output directory. Default: out
  --limit <number>                Scan only the newest N starred repositories.
  --existing-only                 Do not create missing lists; only use existing lists.
  --all-public                    Create missing lists as public. This is the default.
  --all-private                   Create missing lists as private.
  --sync-list-descriptions        Fill empty list descriptions from config.
  --sync-list-visibility          Update existing configured lists to the chosen visibility.
  --only-list-metadata            Only update list descriptions/visibility; do not classify stars.
  --only-list-descriptions        Alias for --only-list-metadata.
  --overwrite-list-descriptions   Replace existing descriptions when syncing.
  --yes, -y                       Skip apply confirmation prompts.
  --verbose                       Print each updated repository/list.
  --quiet                         Hide progress output.
  --help                          Show this help.

Authentication:
  Use gh auth login, or set GITHUB_TOKEN/GH_TOKEN. The token needs the classic "user" scope.
`);
}

async function main() {
  const progress = createProgress({ quiet });
  const viewer = await fetchViewerLists(progress, { includeItems: true });

  const listByName = new Map(viewer.lists.nodes.map((list) => [list.name, list]));
  const listsToCreate = [];
  const listDescriptionUpdates = [];
  const listVisibilityUpdates = [];

  for (const listConfig of config.lists) {
    const isPrivate = resolveListPrivacy(listConfig);
    const existingList = listByName.get(listConfig.name);
    if (existingList) {
      const wantedDescription = listConfig.description ?? "";
      const currentDescription = existingList.description ?? "";
      const shouldUpdateDescription = syncListDescriptions &&
        wantedDescription &&
        currentDescription !== wantedDescription &&
        (overwriteListDescriptions || currentDescription.trim() === "");

      if (shouldUpdateDescription) {
        listDescriptionUpdates.push({
          id: existingList.id,
          name: existingList.name,
          from: currentDescription,
          to: wantedDescription
        });
      }
      if (syncListVisibility && existingList.isPrivate !== isPrivate) {
        listVisibilityUpdates.push({
          id: existingList.id,
          name: existingList.name,
          from: existingList.isPrivate ? "private" : "public",
          to: isPrivate ? "private" : "public",
          isPrivate
        });
      }
      continue;
    }
    if (onlyListMetadata) continue;
    if (existingOnly) continue;
    listsToCreate.push({
      name: listConfig.name,
      description: listConfig.description ?? "",
      isPrivate
    });
    if (!apply) {
      listByName.set(listConfig.name, {
        id: `DRY_RUN:${listConfig.name}`,
        name: listConfig.name,
        description: listConfig.description ?? "",
        isPrivate
      });
      continue;
    }
  }

  if (apply && listsToCreate.length) {
    await confirmListVisibility({ listsToCreate, listVisibilityUpdates: [] });
    for (const list of listsToCreate) {
      const created = await graphql(
        `
        mutation($input: CreateUserListInput!) {
          createUserList(input: $input) {
            list { id name description isPrivate }
          }
        }
        `,
        {
          input: {
            name: list.name,
            description: list.description,
            isPrivate: list.isPrivate
          }
        }
      );
      listByName.set(list.name, created.createUserList.list);
    }
  }

  if (onlyListMetadata) {
    mkdirSync(outDir, { recursive: true });
    const jsonPath = resolve(outDir, "plan-list-metadata.json");
    const mdPath = resolve(outDir, "plan-list-metadata.md");
    writeFileSync(jsonPath, JSON.stringify({
      apply,
      onlyListMetadata,
      listDescriptionUpdates,
      listVisibilityUpdates,
      totalStars: 0,
      changes: [],
      skipped: [],
      unchanged: []
    }, null, 2));
    writeFileSync(mdPath, renderMarkdown({
      apply,
      existingOnly,
      listsToCreate: [],
      listDescriptionUpdates,
      listVisibilityUpdates,
      stars: [],
      changes: [],
      skipped: [],
      unchanged: []
    }));

    if (apply) {
      if (listVisibilityUpdates.length) {
        await confirmListVisibility({ listsToCreate: [], listVisibilityUpdates });
      }
      await applyListDescriptionUpdates(listDescriptionUpdates, progress);
      await applyListVisibilityUpdates(listVisibilityUpdates, progress);
    }

    console.log(`${apply ? "Applied" : "Planned"} ${listDescriptionUpdates.length} list description updates and ${listVisibilityUpdates.length} visibility updates.`);
    console.log(`Wrote ${mdPath}`);
    console.log(`Wrote ${jsonPath}`);
    if (!apply) console.log("Run with --apply to update GitHub Star List descriptions.");
    return;
  }

  const existingAssignments = await fetchExistingAssignments(viewer.lists.nodes, progress);
  const stars = await fetchStars(limit, progress);
  const changes = [];
  const skipped = [];
  const unchanged = [];
  let readmeChecks = 0;
  let readmeHits = 0;
  let processed = 0;

  progress.start(`Classifying stars 0/${stars.length}`);
  for (const repo of stars) {
    processed += 1;
    const allMatches = classify(repo);
    let matches = thresholdMatches(allMatches);
    let readme = "";
    let finalMatches = allMatches;

    if (matches.length === 0 && settings.readmeFallback) {
      readmeChecks += 1;
      progress.tick(`Classifying stars ${processed}/${stars.length} | README checks ${readmeChecks}`);
      readme = await fetchReadme(repo.nameWithOwner);
      if (readme) readmeHits += 1;
      if (readme) {
        finalMatches = classify(repo, readme);
        matches = thresholdMatches(finalMatches);
      }
    }

    if (matches.length === 0) {
      skipped.push({
        repo: repo.nameWithOwner,
        description: repo.description ?? "",
        language: repo.primaryLanguage?.name ?? "",
        topics: topicNames(repo),
        readmeChecked: settings.readmeFallback,
        readmeFound: Boolean(readme),
        bestMatches: finalMatches.slice(0, 3)
      });
      if (processed % 25 === 0 || processed === stars.length) {
        progress.tick(`Classifying stars ${processed}/${stars.length} | README checks ${readmeChecks}, found ${readmeHits}`);
      }
      continue;
    }

    const oldIds = existingAssignments.get(repo.id) ?? [];
    const oldSet = new Set(oldIds);
    const targetIds = new Set(settings.preserveExistingAssignments ? oldIds : []);
    const targetNames = [];

    for (const match of matches) {
      const list = listByName.get(match.name);
      if (!list) continue;
      targetIds.add(list.id);
      targetNames.push({ name: match.name, score: match.score, reasons: match.reasons });
    }

    const hasNewList = [...targetIds].some((id) => !oldSet.has(id));
    if (!hasNewList) {
      unchanged.push({
        repo: repo.nameWithOwner,
        matchedLists: targetNames
      });
      if (processed % 25 === 0 || processed === stars.length) {
        progress.tick(`Classifying stars ${processed}/${stars.length} | README checks ${readmeChecks}, found ${readmeHits}`);
      }
      continue;
    }

    changes.push({
      repo: repo.nameWithOwner,
      id: repo.id,
      oldListIds: [...oldSet],
      targetListIds: [...targetIds],
      targetLists: targetNames
    });

    if (processed % 25 === 0 || processed === stars.length) {
      progress.tick(`Classifying stars ${processed}/${stars.length} | README checks ${readmeChecks}, found ${readmeHits}`);
    }
  }
  progress.done(`Classified ${stars.length} stars | README checks ${readmeChecks}, found ${readmeHits}`);

  mkdirSync(outDir, { recursive: true });
  const basename = existingOnly ? "plan-existing-only" : "plan";
  const jsonPath = resolve(outDir, `${basename}.json`);
  const mdPath = resolve(outDir, `${basename}.md`);
  writeFileSync(jsonPath, JSON.stringify({ apply, existingOnly, listsToCreate, listDescriptionUpdates, listVisibilityUpdates, totalStars: stars.length, changes, skipped, unchanged }, null, 2));
  writeFileSync(mdPath, renderMarkdown({ apply, existingOnly, listsToCreate, listDescriptionUpdates, listVisibilityUpdates, stars, changes, skipped, unchanged }));

  if (apply) {
    if (listVisibilityUpdates.length) {
      await confirmListVisibility({ listsToCreate: [], listVisibilityUpdates });
    }
    if (listDescriptionUpdates.length) {
      await applyListDescriptionUpdates(listDescriptionUpdates, progress);
    }
    if (listVisibilityUpdates.length) {
      await applyListVisibilityUpdates(listVisibilityUpdates, progress);
    }

    progress.start(`Applying updates 0/${changes.length}`);
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      await graphql(
        `
        mutation($input: UpdateUserListsForItemInput!) {
          updateUserListsForItem(input: $input) {
            item { __typename ... on Repository { nameWithOwner } }
          }
        }
        `,
        { input: { itemId: change.id, listIds: change.targetListIds } }
      );
      if (verbose) console.log(`updated ${change.repo}`);
      progress.tick(`Applying updates ${index + 1}/${changes.length}`);
    }
    progress.done(`Applied updates ${changes.length}/${changes.length}`);
  }

  console.log(`${apply ? "Applied" : "Planned"} ${changes.length} repository list updates.`);
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
  if (!apply) console.log("Run with --apply to update GitHub Star Lists.");
}

async function fetchViewerLists(progress, { includeItems = false } = {}) {
  const lists = [];
  let cursor = null;
  let viewerLogin = "";
  let viewerId = "";
  progress.start("Loading viewer lists");

  do {
    const data = await graphql(
      `
      query($cursor: String) {
        viewer {
          login
          id
          lists(first: 100, after: $cursor) {
            nodes {
              id
              name
              description
              isPrivate
              ${includeItems ? `
              items(first: 100) {
                nodes {
                  __typename
                  ... on Repository { id nameWithOwner }
                }
                pageInfo { hasNextPage endCursor }
              }
              ` : ""}
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      `,
      { cursor }
    );

    viewerLogin = data.viewer.login;
    viewerId = data.viewer.id;
    lists.push(...data.viewer.lists.nodes);
    cursor = data.viewer.lists.pageInfo.endCursor;
    progress.tick(`Loading viewer lists ${lists.length}`);
    if (!data.viewer.lists.pageInfo.hasNextPage) break;
  } while (cursor);

  progress.done(`Loaded ${lists.length} viewer lists`);
  return {
    login: viewerLogin,
    id: viewerId,
    lists: { nodes: lists }
  };
}

function buildSuggestionStats(stars) {
  const topics = new Map();
  const languages = new Map();
  const descriptionKeywords = new Map();

  for (const repo of stars) {
    for (const topic of topicNames(repo)) increment(topics, topic);
    const language = repo.primaryLanguage?.name;
    if (language) increment(languages, language);

    const text = `${repo.nameWithOwner} ${repo.description ?? ""}`;
    for (const word of extractKeywords(text)) increment(descriptionKeywords, word);
  }

  return { topics, languages, descriptionKeywords };
}

function suggestListFromExisting(list, stats) {
  const nameTopics = suggestTopicsForListName(list.name);
  const tokens = tokenize(list.name);
  const matchedTopics = topEntries(stats.topics, 100)
    .map(([topic]) => topic)
    .filter((topic) => tokens.some((token) => topic.includes(token) || token.includes(topic)))
    .slice(0, 12);

  return {
    name: list.name,
    description: list.description ?? "",
    isPrivate: list.isPrivate,
    keywords: suggestKeywordsForListName(list.name, stats),
    topics: unique([...nameTopics, ...matchedTopics])
  };
}

function suggestListsFromStats(stats) {
  const general = readPresetConfig(DEFAULT_PRESET);
  const topicSet = new Set(topEntries(stats.topics, 100).map(([topic]) => topic));
  const keywordSet = new Set(topEntries(stats.descriptionKeywords, 100).map(([keyword]) => keyword));
  const languageSet = new Set(topEntries(stats.languages, 50).map(([language]) => language.toLowerCase()));

  return general.lists
    .map((list) => {
      const topics = (list.topics ?? []).filter((topic) => topicSet.has(topic));
      const keywords = (list.keywords ?? []).filter((keyword) => {
        const normalized = keyword.toLowerCase();
        return keywordSet.has(normalized) || languageSet.has(normalized);
      });
      return {
        ...list,
        keywords: unique(keywords).slice(0, 20),
        topics: unique(topics).slice(0, 20)
      };
    })
    .filter((list) => list.keywords.length || list.topics.length)
    .slice(0, 12);
}

function suggestTopicsForListName(name) {
  const aliases = new Map([
    ["ai", ["ai", "machine-learning"]],
    ["llm", ["llm", "rag", "embeddings"]],
    ["agent", ["agents", "ai-agent"]],
    ["agents", ["agents", "ai-agent"]],
    ["frontend", ["frontend", "react", "vue", "svelte"]],
    ["backend", ["backend", "api", "server"]],
    ["devops", ["devops", "docker", "kubernetes"]],
    ["data", ["data-engineering", "analytics"]],
    ["security", ["security", "privacy"]],
    ["cli", ["cli", "terminal", "developer-tools"]],
    ["tools", ["developer-tools", "productivity"]],
    ["mobile", ["mobile", "ios", "android"]],
    ["game", ["game-development", "gamedev"]],
    ["robotics", ["robotics", "ros", "ros2"]],
    ["ros", ["ros", "ros2", "robotics"]],
    ["slam", ["slam", "mapping", "localization"]]
  ]);

  const topics = [];
  for (const token of tokenize(name)) {
    topics.push(...(aliases.get(token) ?? [token]));
  }
  return unique(topics).slice(0, 12);
}

function suggestKeywordsForListName(name, stats) {
  const aliases = new Map([
    ["ai", ["ai", "machine learning"]],
    ["llm", ["llm", "rag", "embedding", "inference"]],
    ["agent", ["agent", "agentic", "mcp"]],
    ["agents", ["agent", "agentic", "mcp"]],
    ["frontend", ["frontend", "react", "vue", "svelte", "ui"]],
    ["backend", ["backend", "api", "server", "database"]],
    ["devops", ["devops", "docker", "kubernetes", "terraform"]],
    ["data", ["data", "analytics", "etl", "pipeline"]],
    ["security", ["security", "auth", "privacy", "encryption"]],
    ["cli", ["cli", "terminal", "tui"]],
    ["tools", ["tool", "utility", "automation"]],
    ["mobile", ["mobile", "ios", "android", "flutter"]],
    ["game", ["game", "gamedev", "graphics"]],
    ["robotics", ["robot", "robotics", "ros", "slam"]],
    ["ros", ["ros", "ros2", "robotics"]],
    ["slam", ["slam", "localization", "mapping"]]
  ]);

  const tokens = tokenize(name);
  const keywords = [];
  for (const token of tokens) {
    if (token.length >= 3) keywords.push(token);
    keywords.push(...(aliases.get(token) ?? []));
  }

  const frequentWords = topEntries(stats.descriptionKeywords, 100)
    .map(([word]) => word)
    .filter((word) => tokens.some((token) => word.includes(token) || token.includes(word)))
    .slice(0, 10);

  return unique([...keywords, ...frequentWords]).slice(0, 20);
}

function extractKeywords(text) {
  const stopwords = new Set([
    "about", "after", "also", "and", "are", "awesome", "based", "build", "built",
    "can", "collection", "for", "from", "github", "into", "its", "library",
    "list", "made", "new", "not", "open", "project", "repo", "repository",
    "simple", "source", "that", "the", "this", "tool", "using", "with", "your"
  ]);

  return tokenize(text)
    .filter((word) => word.length >= 3)
    .filter((word) => !stopwords.has(word))
    .filter((word) => !/^\d+$/.test(word));
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9+.#-]+/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter(Boolean);
}

function topEntries(map, count) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count);
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function applyListDescriptionUpdates(updates, progress) {
  if (!updates.length) return;
  progress.start(`Updating list descriptions 0/${updates.length}`);
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    await graphql(
      `
      mutation($input: UpdateUserListInput!) {
        updateUserList(input: $input) {
          list { id name description }
        }
      }
      `,
      { input: { listId: update.id, description: update.to } }
    );
    if (verbose) console.log(`updated list description ${update.name}`);
    progress.tick(`Updating list descriptions ${index + 1}/${updates.length}`);
  }
  progress.done(`Updated list descriptions ${updates.length}/${updates.length}`);
}

async function applyListVisibilityUpdates(updates, progress) {
  if (!updates.length) return;
  progress.start(`Updating list visibility 0/${updates.length}`);
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    await graphql(
      `
      mutation($input: UpdateUserListInput!) {
        updateUserList(input: $input) {
          list { id name isPrivate }
        }
      }
      `,
      { input: { listId: update.id, isPrivate: update.isPrivate } }
    );
    if (verbose) console.log(`updated list visibility ${update.name}: ${update.to}`);
    progress.tick(`Updating list visibility ${index + 1}/${updates.length}`);
  }
  progress.done(`Updated list visibility ${updates.length}/${updates.length}`);
}

async function fetchExistingAssignments(lists, progress) {
  const assignments = new Map();
  progress.start(`Scanning existing list assignments 0/${lists.length}`);

  for (let index = 0; index < lists.length; index += 1) {
    const list = lists[index];
    let page = list.items;
    addItems(list.id, page.nodes, assignments);

    while (page.pageInfo.hasNextPage) {
      const data = await graphql(
        `
        query($listId: ID!, $cursor: String) {
          node(id: $listId) {
            ... on UserList {
              items(first: 100, after: $cursor) {
                nodes {
                  __typename
                  ... on Repository { id nameWithOwner }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
        `,
        { listId: list.id, cursor: page.pageInfo.endCursor }
      );
      page = data.node.items;
      addItems(list.id, page.nodes, assignments);
    }
    progress.tick(`Scanning existing list assignments ${index + 1}/${lists.length}`);
  }
  progress.done(`Scanned existing list assignments ${lists.length}/${lists.length}`);

  return assignments;
}

function addItems(listId, nodes, assignments) {
  for (const item of nodes ?? []) {
    if (item.__typename !== "Repository") continue;
    const ids = assignments.get(item.id) ?? [];
    ids.push(listId);
    assignments.set(item.id, ids);
  }
}

async function fetchStars(max, progress) {
  const stars = [];
  let cursor = null;
  progress.start("Fetching starred repositories");

  do {
    const first = Math.min(100, max - stars.length);
    if (first <= 0) break;
    const data = await graphql(
      `
      query($first: Int!, $cursor: String) {
        viewer {
          starredRepositories(first: $first, after: $cursor, orderBy: {field: STARRED_AT, direction: DESC}) {
            nodes {
              id
              name
              nameWithOwner
              description
              homepageUrl
              primaryLanguage { name }
              repositoryTopics(first: 30) {
                nodes { topic { name } }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      `,
      { first, cursor }
    );
    stars.push(...data.viewer.starredRepositories.nodes);
    const total = Number.isFinite(max) ? max : "all";
    progress.tick(`Fetching starred repositories ${stars.length}/${total}`);
    cursor = data.viewer.starredRepositories.pageInfo.endCursor;
    if (!data.viewer.starredRepositories.pageInfo.hasNextPage) break;
  } while (stars.length < max);

  progress.done(`Fetched ${stars.length} starred repositories`);
  return stars;
}

async function fetchReadme(nameWithOwner) {
  const response = await fetch(`https://api.github.com/repos/${nameWithOwner}/readme`, {
    headers: {
      authorization: `bearer ${getToken()}`,
      accept: "application/vnd.github.raw",
      "user-agent": "git-star-organizer"
    }
  });

  if (response.status === 404) return "";
  if (!response.ok) return "";

  const text = await response.text();
  return text.slice(0, settings.readmeMaxChars);
}

function thresholdMatches(matches) {
  return matches
    .filter((match) => match.score >= settings.minScore)
    .slice(0, settings.maxListsPerRepo);
}

function classify(repo, extraText = "") {
  const metadataHaystack = [
    repo.nameWithOwner,
    repo.description ?? "",
    repo.homepageUrl ?? "",
    repo.primaryLanguage?.name ?? "",
    ...topicNames(repo)
  ].join(" ").toLowerCase();
  const readmeHaystack = extraText.toLowerCase();
  const topics = new Set(topicNames(repo));

  return config.lists
    .map((list) => {
      let score = 0;
      const reasons = [];
      const seenReasons = new Set();

      for (const topic of list.topics ?? []) {
        if (topics.has(topic.toLowerCase())) {
          score += 3;
          addReason(reasons, seenReasons, `topic:${topic}`);
        }
      }

      for (const keyword of list.keywords ?? []) {
        const needle = keyword.toLowerCase();
        if (matchesKeyword(metadataHaystack, needle)) {
          score += needle.includes(" ") ? 2 : 1;
          addReason(reasons, seenReasons, `keyword:${keyword}`);
        }

        if (
          readmeHaystack &&
          !settings.readmeIgnoredKeywords.includes(needle) &&
          matchesKeyword(readmeHaystack, needle)
        ) {
          score += needle.includes(" ") ? 2 : 1;
          addReason(reasons, seenReasons, `readme:${keyword}`);
        }
      }

      return { name: list.name, score, reasons };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function topicNames(repo) {
  return (repo.repositoryTopics?.nodes ?? []).map((node) => node.topic.name.toLowerCase());
}

function addReason(reasons, seenReasons, reason) {
  if (seenReasons.has(reason)) return;
  seenReasons.add(reason);
  reasons.push(reason);
}

function matchesKeyword(haystack, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startsWithWord = /^[a-z0-9]/i.test(keyword);
  const endsWithWord = /[a-z0-9]$/i.test(keyword);
  const prefix = startsWithWord ? "(^|[^a-z0-9])" : "";
  const suffix = endsWithWord ? "($|[^a-z0-9])" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "i").test(haystack);
}

function renderMarkdown({ apply, existingOnly, listsToCreate, listDescriptionUpdates, listVisibilityUpdates = [], stars, changes, skipped, unchanged }) {
  const lines = [
    `# GitHub Star List ${apply ? "Apply" : "Plan"}`,
    "",
    `- Stars scanned: ${stars.length}`,
    `- Repositories to update: ${changes.length}`,
    `- Unmatched repositories: ${skipped.length}`,
    `- Already covered repositories: ${unchanged.length}`,
    `- Existing lists only: ${existingOnly ? "yes" : "no"}`,
    `- Lists to create: ${listsToCreate.length ? listsToCreate.map(formatListCreate).join(", ") : "none"}`,
    `- List descriptions to update: ${listDescriptionUpdates.length}`,
    `- List visibility changes: ${listVisibilityUpdates.length}`,
    ""
  ];

  if (listDescriptionUpdates.length) {
    lines.push("## List Description Updates");
    lines.push("");
    for (const update of listDescriptionUpdates) {
      lines.push(`### ${update.name}`);
      if (update.from) lines.push(`- from: ${update.from}`);
      lines.push(`- to: ${update.to}`);
      lines.push("");
    }
  }

  if (listVisibilityUpdates.length) {
    lines.push("## List Visibility Changes");
    lines.push("");
    for (const update of listVisibilityUpdates) {
      lines.push(`### ${update.name}`);
      lines.push(`- from: ${update.from}`);
      lines.push(`- to: ${update.to}`);
      lines.push("");
    }
  }

  if (changes.length) {
    lines.push("## Updates");
    lines.push("");

    for (const change of changes) {
      lines.push(`### ${change.repo}`);
      for (const target of change.targetLists) {
        lines.push(`- ${target.name} (score ${target.score}): ${target.reasons.join(", ")}`);
      }
      lines.push("");
    }
  }

  if (skipped.length) {
    lines.push("## Unmatched");
    lines.push("");
    for (const item of skipped) {
      const metadata = [
        item.language ? `language: ${item.language}` : null,
        item.topics.length ? `topics: ${item.topics.join(", ")}` : null,
        item.description ? `description: ${item.description}` : null
      ].filter(Boolean);
      lines.push(`### ${item.repo}`);
      if (metadata.length) lines.push(`- ${metadata.join(" | ")}`);
      if (item.bestMatches.length) {
        for (const match of item.bestMatches) {
          lines.push(`- below threshold: ${match.name} (score ${match.score}): ${match.reasons.join(", ")}`);
        }
      } else {
        lines.push("- no configured keyword/topic matched");
      }
      lines.push("");
    }
  }

  if (unchanged.length) {
    lines.push("## Already Covered");
    lines.push("");
    for (const item of unchanged) {
      lines.push(`### ${item.repo}`);
      for (const match of item.matchedLists) {
        lines.push(`- ${match.name} (score ${match.score}): ${match.reasons.join(", ")}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatListCreate(list) {
  if (typeof list === "string") return list;
  return `${list.name} (${list.isPrivate ? "private" : "public"})`;
}

async function graphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${getToken()}`,
      "content-type": "application/json",
      "user-agent": "git-star-organizer"
    },
    body: JSON.stringify({ query, variables })
  });

  const body = await response.json();
  if (!response.ok || body.errors) {
    fail(JSON.stringify(body, null, 2));
  }
  return body.data;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function createProgress({ quiet }) {
  const enabled = !quiet && process.stderr.isTTY;
  let lastLength = 0;

  function write(message, final = false) {
    if (!enabled) return;
    const text = final ? `✓ ${message}` : renderSpinner(message);
    const padding = " ".repeat(Math.max(0, lastLength - text.length));
    process.stderr.write(`\r${text}${padding}`);
    lastLength = text.length;
    if (final) {
      process.stderr.write("\n");
      lastLength = 0;
    }
  }

  return {
    start(message) {
      write(message);
    },
    tick(message) {
      write(message);
    },
    done(message) {
      write(message, true);
    }
  };
}

function renderSpinner(message) {
  const frames = ["-", "\\", "|", "/"];
  const frame = frames[Math.floor(Date.now() / 120) % frames.length];
  return `${frame} ${message}`;
}

main().catch((error) => fail(error.stack || error.message));
