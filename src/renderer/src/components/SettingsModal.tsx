import { useState, useEffect, type CSSProperties } from 'react';
import { AGENT_MODELS, type HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import {
  CLONE_NODE_BLURB,
  DEFAULT_TRIGGER_MODE,
  DEFAULT_WEBHOOK_SCHEMA,
  TRIGGER_MODES,
  type OrgTriggerConfig,
  type TriggerMode,
  type WebhookTrigger
} from '@shared/triggers';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { UpdatesSection } from './UpdatesSection';
import { SettingsHeroCard } from './SettingsHeroCard';
import { SetupPanel } from './SetupPanel';
import { Icon } from './Icon';
import { OfficeThemePicker } from './OfficeThemePicker';
import { McpDefaultsSettings } from './McpDefaultsSettings';
import { IntegrationsRegistry } from './IntegrationsRegistry';
import { AiEnginesSettings } from './AiEnginesSettings';
import { REALTIME_MODEL } from '@shared/realtimePricing';
import { RealtimeDevicePicker } from '@/realtime/DevicePicker';
import { CostHud } from '@/realtime/CostHud';

export interface SettingsModalProps {
  config: HarnessConfig;
  onClose: () => void;
  /** Open straight to a section instead of General. Used by deep links from
   *  elsewhere in the UI — "set it now" beside a disabled Talk button lands on
   *  the tab that actually holds the field, rather than making the user hunt. */
  initialSection?: Section;
}

/**
 * The triggers IPC surface. `src/preload/index.ts` is owned by another lane and
 * these methods are landing there in parallel, so `CthApi` doesn't declare them
 * yet — read them off a narrow local view instead of widening the preload
 * contract from the renderer. Every call site wraps them in try/catch, which also
 * covers the window in which a method is still missing at runtime.
 */
interface TriggersApi {
  listWebhooks: () => Promise<WebhookTrigger[]>;
  saveWebhooks: (list: WebhookTrigger[]) => Promise<{ ok: boolean; error?: string }>;
  deleteWebhook: (id: string) => Promise<{ ok: boolean; error?: string }>;
  generateWebhookSecret: () => Promise<{ ok: boolean; secret?: string }>;
  webhooksStatus: () => Promise<{ running: boolean; url?: string }>;
  getOrgTrigger: () => Promise<OrgTriggerConfig>;
  setOrgTrigger: (cfg: OrgTriggerConfig) => Promise<{ ok: boolean; error?: string }>;
}
const triggersApi = (): TriggersApi => window.cth as unknown as TriggersApi;

/** Process-unique id for a new webhook — it is the path segment callers POST to,
 *  so it must be stable and collision-free across renames. */
function newWebhookId(): string {
  return `wh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Pixel-aesthetic text input, mirroring AddAgentModal's inputStyle. */
const slackInputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

const slackLabelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};

/** The exact connect walkthrough shown behind the i icon. Steps 6 & 7 spell out
 *  the both-lists requirement: subscribe to message.channels / message.groups in
 *  BOTH "Subscribe to bot events" AND "Subscribe to events on behalf of users". */
const SLACK_CONNECT_STEPS = `Munder Difflin を Slack に接続する

1. api.slack.com/apps -> Create New App -> From scratch。アプリ名を
   "Munder Difflin" にしてワークスペースを選択。
2. Basic Information -> Signing Secret -> こちらの
   「Signing secret」欄にコピー。
3. OAuth & Permissions -> Bot Token Scopes: 以下を追加
     chat:write          （オフィスがスレッド内で返信）
     channels:history    （公開チャンネルのメッセージを読み取り）
     groups:history      （非公開チャンネルのメッセージを読み取り）
   Install to workspace した後、Bot User OAuth Token
   （xoxb-...）をこちらの「Bot token」欄にコピー。
4. 下の Start を押してWebhookを起動し、Request URL を取得。
5. Event Subscriptions -> Enable Events -> Request URL: ここで表示された
   Request URL を貼り付け、Slackの緑チェック（Verified）を待つ。
6. Event Subscriptions -> "Subscribe to bot events": 以下を追加
     message.channels
     message.groups
7. Event Subscriptions -> "Subscribe to events on behalf of users"
   （Slackに求められた場合は先に対応する User Token Scope の
   channels:history / groups:history を追加）：以下を追加
     message.channels
     message.groups
8. Save Changes し、Slackに促されたら再インストール。その後ボットを
   チャンネルに招待：  /invite @MunderDifflin`;

/** The request/response contract shown behind the webhook i icon. Every webhook
 *  shares one server and one tunnel and is told apart by its id in the path, so
 *  `<tunnel>` is the public base URL and `<webhookId>` picks the endpoint. The
 *  secret/token go in headers so they stay out of URLs and access logs. */
const WEBHOOK_API_DOC = `Webhook API

各Webhookには固有のURL・シークレット・モードがあります。すべてが同一の
サーバーとトンネルを共有し、パス内のidで呼び出し先を判別します。

作業をトリガーする（POST <tunnel>/<webhookId>）:
  header  x-md-webhook-secret: <そのWebhookのシークレット>
  body    {"message": "do X for me", "title": "省略可能な短いタイトル",
           "kind": "directive" | "communication", "from": "呼び出し元"}
  -> 200  {"ok": true, "token": "<capability token>", "taskId": "<カードid>"}
  -> 202  {"ok": true, "status": "awaiting approval"}

ステータス確認（GET <tunnel>/<webhookId>）:
  header  x-md-webhook-token: <token>     （または  ?token=<token>）
  -> 200  {"ok": true, "status": "todo|doing|blocked|done",
           "title": "...", "result": "<概要またはnull>"}

モードによって返る回答が変わります:
  allow all           すべて即時通過 -> 200
  communication only  雑談は通過。directive は 202 承認待ち
  strict              すべて 202 承認待ち

202は、承認するまでメッセージが Trigger History に保留されることを意味します。
渡されたトークンでも、ルーティング後のそのタスクの状態を一度読み取れます。
シークレットは新しい作業を承認し、トークンは1つのタスク状態を読むのみです。
両方とも秘密にしてください。

各Webhookは独自のJSONスキーマでbodyを検証します — Michael's Command Center の
Triggersタブで編集できます。`;

/** Clear every renderer-side persisted key so a relaunch starts truly empty. */
function clearLocalState(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('cth.')) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch { /* noop */ }
}

// v0.3.4 redesign: six tabs, one topic each. 'AI Engines' folded into
// Agents & Models; MCP + Slack + webhook + REST live together in Connections;
// voice gets its own tab; Danger Zone became a red row at the bottom of General.
export type Section = 'General' | 'Prerequisites' | 'Agents & Models' | 'Autonomy & Budgets' | 'Connections' | 'Voice' | 'Memory & Knowledge';
const NAV_SECTIONS: Section[] = ['General', 'Prerequisites', 'Agents & Models', 'Autonomy & Budgets', 'Connections', 'Voice', 'Memory & Knowledge'];

export function SettingsModal({ config, onClose, initialSection }: SettingsModalProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeSection, setActiveSection] = useState<Section>(initialSection ?? 'General');

  // Change-home flow: null until the user picks a new folder, then the sub-modal
  // confirms move-vs-fresh. Pre-selects 'move' (recommended - keeps the data).
  const [changeHome, setChangeHome] = useState<string | null>(null);
  const [changeMode, setChangeMode] = useState<'move' | 'fresh'>('move');
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeErr, setChangeErr] = useState('');

  // `notifications` is an optional field on the main-process config; the renderer
  // mirror type may not declare it yet, so read it defensively.
  const [notifications, setNotifications] = useState<boolean>(
    (config as HarnessConfig & { notifications?: boolean }).notifications === true
  );

  const toggleNotifications = async () => {
    const next = !notifications;
    setNotifications(next); // optimistic
    try { await window.cth.setNotifications(next); }
    catch { setNotifications(!next); /* revert on failure */ }
  };

  // ─── v0.3.4 redesign: settings that were onboarding-trapped or UI-less ────
  const cfgX = config as HarnessConfig & {
    strongKeepalive?: boolean; audience?: string; autoMode?: boolean;
    defaultModel?: string; maxTurns?: number; semanticMemory?: boolean;
  };
  const [keepAwake, setKeepAwake] = useState<boolean>(cfgX.strongKeepalive === true);
  const toggleKeepAwake = async () => {
    const next = !keepAwake;
    setKeepAwake(next);
    try { await window.cth.updateConfig({ strongKeepalive: next } as Partial<HarnessConfig>); }
    catch { setKeepAwake(!next); }
  };
  const [simpleMode, setSimpleMode] = useState<boolean>(cfgX.audience === 'non-technical');
  const toggleSimpleMode = async () => {
    const next = !simpleMode;
    setSimpleMode(next);
    try { await window.cth.updateConfig({ audience: next ? 'non-technical' : 'technical' } as Partial<HarnessConfig>); }
    catch { setSimpleMode(!next); }
  };
  const [autoModeOn, setAutoModeOn] = useState<boolean>(cfgX.autoMode !== false);
  const toggleAutoMode = async () => {
    const next = !autoModeOn;
    setAutoModeOn(next);
    try { await window.cth.updateConfig({ autoMode: next } as Partial<HarnessConfig>); }
    catch { setAutoModeOn(!next); }
  };
  // Default OFF, so an absent value must read as off. Note this is `=== true`,
  // the mirror image of autoMode's `!== false` above, because the two defaults
  // are opposite.
  const [orchSpawnOn, setOrchSpawnOn] = useState<boolean>(cfgX.orchestratorMaySpawn === true);
  const toggleOrchSpawn = async () => {
    const next = !orchSpawnOn;
    setOrchSpawnOn(next);
    try { await window.cth.updateConfig({ orchestratorMaySpawn: next } as Partial<HarnessConfig>); }
    catch { setOrchSpawnOn(!next); }
  };
  const [defaultModelSel, setDefaultModelSel] = useState<string>(cfgX.defaultModel ?? 'claude-fable-5');
  const [defaultModelNote, setDefaultModelNote] = useState('');
  const saveDefaultModel = async (id: string) => {
    setDefaultModelSel(id);
    try {
      await window.cth.updateConfig({ defaultModel: id } as Partial<HarnessConfig>);
      setDefaultModelNote('保存しました — 新しく起動するエージェントに適用されます');
      setTimeout(() => setDefaultModelNote(''), 2200);
    } catch { setDefaultModelNote('保存に失敗しました'); }
  };
  const [maxTurnsVal, setMaxTurnsVal] = useState<string>(cfgX.maxTurns != null ? String(cfgX.maxTurns) : '');
  const saveMaxTurns = async () => {
    const n = maxTurnsVal.trim() === '' ? undefined : Number(maxTurnsVal);
    await window.cth.updateConfig({ maxTurns: Number.isFinite(n as number) && (n as number) > 0 ? Math.round(n as number) : undefined } as Partial<HarnessConfig>);
  };
  const [semMemOn, setSemMemOn] = useState<boolean>(cfgX.semanticMemory !== false);
  const toggleSemMem = async () => {
    const next = !semMemOn;
    setSemMemOn(next);
    try { await window.cth.updateConfig({ semanticMemory: next } as Partial<HarnessConfig>); }
    catch { setSemMemOn(!next); }
  };

  // --- circuit-breaker config (Lane A #6 canonical fields, widened view) ---
  // Drives Jim's real breaker: floor-wide TOKEN budget (costCapTokens) + output-
  // token velocity ceiling (circuitBreaker.tokenVelocityPerMin). The token cap
  // replaced the old dollar cap as the user-facing budget.
  type BreakerCfgView = HarnessConfig & {
    costCapTokens?: number;
    circuitBreaker?: { tokenVelocityPerMin?: number; enabled?: boolean; hardStop?: boolean; repeatedToolLimit?: number; errorStormLimit?: number };
  };
  const breakerCfg = config as BreakerCfgView;
  const [agentBudget, setAgentBudget] = useState(breakerCfg.costCapTokens != null ? String(breakerCfg.costCapTokens) : '');
  const [velocityCeiling, setVelocityCeiling] = useState(breakerCfg.circuitBreaker?.tokenVelocityPerMin != null ? String(breakerCfg.circuitBreaker.tokenVelocityPerMin) : '');
  const [budgetNote, setBudgetNote] = useState('');
  // v0.3.4: the four previously UI-less breaker fields get controls.
  const [brkEnabled, setBrkEnabled] = useState<boolean>(breakerCfg.circuitBreaker?.enabled !== false);
  const [brkHardStop, setBrkHardStop] = useState<boolean>(breakerCfg.circuitBreaker?.hardStop === true);
  const [brkRepeated, setBrkRepeated] = useState(breakerCfg.circuitBreaker?.repeatedToolLimit != null ? String(breakerCfg.circuitBreaker.repeatedToolLimit) : '');
  const [brkErrStorm, setBrkErrStorm] = useState(breakerCfg.circuitBreaker?.errorStormLimit != null ? String(breakerCfg.circuitBreaker.errorStormLimit) : '');
  const saveBudget = async () => {
    const tokens = agentBudget.trim() === '' ? undefined : Number(agentBudget);
    const vel = velocityCeiling.trim() === '' ? undefined : Number(velocityCeiling);
    const rep = brkRepeated.trim() === '' ? undefined : Number(brkRepeated);
    const storm = brkErrStorm.trim() === '' ? undefined : Number(brkErrStorm);
    await window.cth.updateConfig({
      costCapTokens: Number.isFinite(tokens as number) ? (tokens as number) : undefined,
      circuitBreaker: {
        ...(breakerCfg.circuitBreaker ?? {}),
        enabled: brkEnabled,
        hardStop: brkHardStop,
        tokenVelocityPerMin: Number.isFinite(vel as number) ? (vel as number) : undefined,
        repeatedToolLimit: Number.isFinite(rep as number) ? Math.round(rep as number) : undefined,
        errorStormLimit: Number.isFinite(storm as number) ? Math.round(storm as number) : undefined
      }
    } as Partial<HarnessConfig>);
    setBudgetNote('保存しました');
    setTimeout(() => setBudgetNote(''), 1500);
  };
  const fmtBudgetTokens = (raw: string): string => {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) return '';
    if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
    return String(n);
  };

  // --- Slack integration ---
  const [slackEnabled, setSlackEnabled] = useState(config.slackEnabled ?? false);
  const [slackSecret, setSlackSecret] = useState(config.slackSigningSecret ?? '');
  const [slackBotToken, setSlackBotToken] = useState(config.slackBotToken ?? '');
  const [slackChannel, setSlackChannel] = useState(config.slackChannelId ?? '');
  const [slackPort, setSlackPort] = useState(String(config.slackPort ?? 3847));
  // App/voice-initiated proactive posting (the "queued" ack). Default OFF —
  // the Slack-origin done-reply round-trip is unaffected by this toggle.
  const [slackProactivePosting, setSlackProactivePosting] = useState(config.slackProactivePosting ?? false);
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackNote, setSlackNote] = useState('');
  // Whether the webhook server is currently live. Hydrated from main on open so
  // reopening Settings shows the true connection state + the persisted Request URL.
  const [running, setRunning] = useState(false);
  // Whether the connect-steps help panel is expanded.
  const [showSlackHelp, setShowSlackHelp] = useState(false);

  // --- Webhook triggers (a LIST; src/shared/triggers.ts owns the type) ---------
  // The list itself lives in the store, not in local state: the Triggers tab
  // edits the same webhooks, and one of the two surfaces holding a private copy
  // is exactly the drift this feature exists to prevent.
  const webhookTriggers = useStore((s) => s.webhookTriggers);
  const setWebhookTriggersStore = useStore((s) => s.setWebhookTriggers);
  /** Public base URL of the shared tunnel; each webhook's endpoint is `<base>/<id>`. */
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookRunning, setWebhookRunning] = useState(false);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookNote, setWebhookNote] = useState('');
  /** Which secrets the user has unmasked, by webhook id. Reset on every reopen. */
  const [shownSecrets, setShownSecrets] = useState<Record<string, boolean>>({});
  /** Webhook awaiting a second delete click — deleting one revokes a live caller. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [showWebhookHelp, setShowWebhookHelp] = useState(false);

  // --- Organisation trigger (peer messaging; configuration only for now) ------
  const orgTrigger = useStore((s) => s.orgTrigger);
  const setOrgTriggerStore = useStore((s) => s.setOrgTrigger);
  const [showOrgKey, setShowOrgKey] = useState(false);
  const [orgBusy, setOrgBusy] = useState(false);
  const [orgNote, setOrgNote] = useState('');

  // ─── Knowledge Graph (enterprise multimodal context for agents) ───────────
  const [kgEnabled, setKgEnabled] = useState<boolean>(
    (config as HarnessConfig & { knowledgeGraph?: { enabled?: boolean } }).knowledgeGraph?.enabled === true
  );
  const [kgDocCount, setKgDocCount] = useState(0);
  const [kgBusy, setKgBusy] = useState(false);
  const [kgNote, setKgNote] = useState('');

  const refreshKgStatus = async () => {
    try { const s = await window.cth.kgStatus(); setKgDocCount(s.docCount); }
    catch { /* status unavailable */ }
  };

  const toggleKg = async () => {
    const next = !kgEnabled;
    setKgEnabled(next);
    try {
      await window.cth.updateConfig({ knowledgeGraph: { enabled: next } });
      if (next) await refreshKgStatus();
    } catch { setKgEnabled(!next); }
  };

  const addKgFiles = async () => {
    setKgBusy(true); setKgNote('');
    try {
      const res = await window.cth.kgAddFiles();
      if (!res.ok) { setKgNote(res.error === 'cancelled' ? '' : (res.error ?? '失敗しました')); return; }
      const added = res.results.filter((r) => r.ok).length;
      const failed = res.results.length - added;
      setKgNote(`ドキュメントを${added}件追加しました${failed ? `（${failed}件失敗）` : ''}`);
      await refreshKgStatus();
    } catch (e) { setKgNote(e instanceof Error ? e.message : String(e)); }
    finally { setKgBusy(false); }
  };

  // ─── Scheduled auto-compact — the compact-maintenance mission's enabled flag.
  // The mission itself stays the single source of truth (the Triggers tab edits
  // the same field); this is just a General-section shortcut. Default OFF (v0.3.4).
  const [autoCompactOn, setAutoCompactOn] = useState<boolean>(
    (config.missions ?? []).some((m) => m.id === 'compact-maintenance' && m.enabled)
  );
  const toggleAutoCompact = async () => {
    const next = !autoCompactOn;
    setAutoCompactOn(next);
    try {
      const cfg = await window.cth.getConfig();
      const missions = (cfg.missions ?? []).map((m) =>
        m.id === 'compact-maintenance' ? { ...m, enabled: next } : m
      );
      await window.cth.updateConfig({ missions });
    } catch { setAutoCompactOn(!next); }
  };

  // ─── Auto-update (default ON; gates main's updater checks entirely) ────────
  const [autoUpdateOn, setAutoUpdateOn] = useState<boolean>(config.autoUpdate !== false);
  const toggleAutoUpdate = async () => {
    const next = !autoUpdateOn;
    setAutoUpdateOn(next);
    try { await window.cth.updateConfig({ autoUpdate: next }); }
    catch { setAutoUpdateOn(!next); }
  };

  // ─── Anonymous usage stats (default ON = opt-out; contract in TELEMETRY.md) ─
  const [telemetryOn, setTelemetryOn] = useState<boolean>(config.telemetryEnabled !== false);
  const toggleTelemetry = async () => {
    const next = !telemetryOn;
    setTelemetryOn(next);
    try { await window.cth.updateConfig({ telemetryEnabled: next }); }
    catch { setTelemetryOn(!next); }
  };

  // --- Free Flow (voice dictation → message queue) ---
  const setFreeflowEnabledStore = useStore((s) => s.setFreeflowEnabled);
  const setHasGroqKeyStore = useStore((s) => s.setHasGroqKey);
  // Talk (Realtime Michael) is gated on the OpenAI key — read the live presence
  // boolean so the Realtime Michael section can show its enabled/disabled status.
  const hasOpenAiKey = useStore((s) => s.hasOpenAiKey);
  // Voice-tab entry for the SAME broker slot Agents & Models writes (apikey:openai).
  // Mirroring presence into the store on save is what makes the Talk button light up
  // immediately instead of on next launch.
  const setHasOpenAiKey = useStore((s) => s.setHasOpenAiKey);
  const [openAiVoiceKey, setOpenAiVoiceKey] = useState('');
  const [openAiVoiceNote, setOpenAiVoiceNote] = useState('');
  const saveOpenAiVoiceKey = async (): Promise<void> => {
    const key = openAiVoiceKey.trim();
    if (!key) return;
    try {
      const r = await window.cth.providerKeySet({ backend: 'openai', key });
      if (r.ok) {
        setOpenAiVoiceKey('');
        setHasOpenAiKey(true);
        setOpenAiVoiceNote('キーを保存しました — Talk を利用できます。');
      } else setOpenAiVoiceNote(r.error ?? 'キーを保存できませんでした。');
    } catch (e) {
      setOpenAiVoiceNote(e instanceof Error ? e.message : String(e));
    }
  };
  // v0.3.4 fix: the config default is ON ('now on by default', 0.2.7) — seeding
  // with `?? false` displayed OFF while the feature was actually running.
  const [freeflowEnabled, setFreeflowEnabled] = useState(config.freeflowEnabled !== false);
  const [groqKey, setGroqKey] = useState(config.groqApiKey ?? '');
  const [freeflowModel, setFreeflowModel] = useState(config.freeflowModel ?? 'whisper-large-v3-turbo');
  const [showGroqKey, setShowGroqKey] = useState(false);
  const [freeflowBusy, setFreeflowBusy] = useState(false);
  const [freeflowNote, setFreeflowNote] = useState('');
  // rt-9 idle-tunable: realtime voice idle auto-disconnect window (ms); 0 = never.
  const [idleDisconnectMs, setIdleDisconnectMs] = useState<number>(
    (config as HarnessConfig).realtimeIdleDisconnectMs ?? 180_000
  );

  // Re-seed every editable field from the on-disk config when the modal opens.
  // App's `config` prop is loaded once and never refreshed after a save, so
  // without this the saved budget / velocity / slack values show blank on reopen.
  useEffect(() => {
    let alive = true;
    window.cth.getConfig().then((c) => {
      if (!alive) return;
      const cc = c as BreakerCfgView;
      setNotifications(cc.notifications === true);
      setAgentBudget(cc.costCapTokens != null ? String(cc.costCapTokens) : '');
      setVelocityCeiling(cc.circuitBreaker?.tokenVelocityPerMin != null ? String(cc.circuitBreaker.tokenVelocityPerMin) : '');
      setSlackEnabled(cc.slackEnabled ?? false);
      setSlackSecret(cc.slackSigningSecret ?? '');
      setSlackBotToken(cc.slackBotToken ?? '');
      setSlackChannel(cc.slackChannelId ?? '');
      setSlackPort(String(cc.slackPort ?? 3847));
      setSlackProactivePosting(cc.slackProactivePosting ?? false);
      const kgOn = (cc as { knowledgeGraph?: { enabled?: boolean } }).knowledgeGraph?.enabled === true;
      setKgEnabled(kgOn);
      setFreeflowEnabled(cc.freeflowEnabled !== false);
      setGroqKey(cc.groqApiKey ?? '');
      setFreeflowModel(cc.freeflowModel ?? 'whisper-large-v3-turbo');
      setIdleDisconnectMs((c as HarnessConfig).realtimeIdleDisconnectMs ?? 180_000);
    }).catch(() => { /* keep prop-seeded values */ });
    window.cth.kgStatus().then((s) => { if (alive) setKgDocCount(s.docCount); })
      .catch(() => { /* status unavailable */ });
    // Hydrate live connection state + the persisted Request URL: the
    // tunnel URL lives in main, so reopening Settings while connected re-shows it.
    window.cth.slackStatus().then((s) => {
      if (!alive) return;
      setRunning(s.running);
      if (s.url) setTunnelUrl(s.url);
    }).catch(() => { /* status unavailable - assume not running */ });
    // Triggers: re-read main and push the result into the shared mirror. App
    // already seeded it at launch; this catches anything the Triggers tab (or
    // another window) changed since, and is the ONLY place Settings reads them —
    // every render below comes off the store.
    void (async () => {
      try {
        const list = await triggersApi().listWebhooks();
        if (alive && Array.isArray(list)) useStore.getState().setWebhookTriggers(list);
      } catch { /* keep the mirror App seeded from getConfig() */ }
      try {
        const org = await triggersApi().getOrgTrigger();
        if (alive && org) useStore.getState().setOrgTrigger(org);
      } catch { /* ditto */ }
      try {
        const s = await triggersApi().webhooksStatus();
        if (!alive) return;
        setWebhookRunning(s.running);
        if (s.url) setWebhookUrl(s.url);
      } catch { /* status unavailable - assume not listening */ }
    })();
    return () => { alive = false; };
  }, []);

  /** Persist the current Slack inputs. Returns the resolved config patch. */
  const slackPatch = (enabled: boolean) => ({
    signingSecret: slackSecret,
    botToken: slackBotToken,
    channelId: slackChannel,
    port: Number(slackPort) || 3847,
    enabled,
    proactivePosting: slackProactivePosting
  });

  const saveSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      await window.cth.slackSetConfig(slackPatch(slackEnabled));
      setSlackNote('保存しました');
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };

  const startSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      // Persist first so the server starts with the latest secret/port/channel.
      await window.cth.slackSetConfig(slackPatch(true));
      setSlackEnabled(true);
      const res = await window.cth.slackStart();
      if (res.ok) {
        setRunning(true);
        // Keep the last URL if this start returned none (tunnel hiccup) - don't blank it.
        if (res.url) setTunnelUrl(res.url);
        setSlackNote(res.url ? '待ち受け中' : (res.error ?? '開始しましたが、トンネルを利用できません'));
      } else {
        setSlackNote(res.error ?? '開始に失敗しました');
      }
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };

  const stopSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    // Keep the last Request URL visible (greyed) after Stop.
    try { await window.cth.slackStop(); setRunning(false); setSlackNote('停止しました'); }
    catch (e) { setSlackNote(e instanceof Error ? e.message : String(e)); }
    finally { setSlackBusy(false); }
  };

  // --- Webhook trigger handlers ---
  /** The one write path. Updates the shared mirror FIRST so the Triggers tab
   *  repaints immediately, then persists. Pass `persist: false` for keystroke
   *  edits (a rename) — the blur commits them. */
  const applyWebhooks = async (list: WebhookTrigger[], persist = true) => {
    setWebhookTriggersStore(list);
    if (!persist) return;
    setWebhookBusy(true); setWebhookNote('');
    try {
      const res = await triggersApi().saveWebhooks(list);
      if (res && res.ok === false) { setWebhookNote(res.error ?? '保存できませんでした'); return; }
      setWebhookNote('保存しました');
      setTimeout(() => setWebhookNote(''), 1500);
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
  };

  /** Replace one entry by id (the shape every per-row control uses). */
  const patchWebhook = (id: string, patch: Partial<WebhookTrigger>, persist = true) =>
    applyWebhooks(webhookTriggers.map((w) => (w.id === id ? { ...w, ...patch } : w)), persist);

  /** New endpoint: main mints the secret (256-bit), and it ships DISABLED —
   *  turning on a public surface is always an explicit second click. */
  const addWebhook = async () => {
    setWebhookBusy(true); setWebhookNote('');
    let secret = '';
    try {
      const res = await triggersApi().generateWebhookSecret();
      secret = res.ok && res.secret ? res.secret : '';
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
    if (!secret) { setWebhookNote('シークレットを生成できませんでした'); return; }
    const entry: WebhookTrigger = {
      id: newWebhookId(),
      name: `Webhook ${webhookTriggers.length + 1}`,
      secret,
      enabled: false,
      mode: DEFAULT_TRIGGER_MODE,
      schema: DEFAULT_WEBHOOK_SCHEMA,
      createdAt: Date.now()
    };
    setShownSecrets((s) => ({ ...s, [entry.id]: true })); // show it once, to copy
    await applyWebhooks([...webhookTriggers, entry]);
  };

  /** Mint a fresh secret for ONE endpoint. The old one stops working at once —
   *  that is the point, and it never disturbs the other webhooks. */
  const rotateWebhookSecret = async (id: string) => {
    setWebhookBusy(true); setWebhookNote('');
    let secret = '';
    try {
      const res = await triggersApi().generateWebhookSecret();
      secret = res.ok && res.secret ? res.secret : '';
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
    if (!secret) { setWebhookNote('シークレットを生成できませんでした'); return; }
    setShownSecrets((s) => ({ ...s, [id]: true }));
    await patchWebhook(id, { secret });
    setWebhookNote('新しいシークレット — 今すぐコピーしてください');
  };

  const removeWebhook = async (id: string) => {
    setPendingDelete(null);
    setWebhookBusy(true); setWebhookNote('');
    try {
      await triggersApi().deleteWebhook(id);
      setWebhookNote('削除しました');
      setTimeout(() => setWebhookNote(''), 1500);
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
    // Mirror the removal either way: if main rejected it, the next open re-reads.
    setWebhookTriggersStore(webhookTriggers.filter((w) => w.id !== id));
  };

  /** Endpoint URL for one webhook: every entry shares the tunnel, the id picks it. */
  const webhookEndpoint = (id: string) => (webhookUrl ? `${webhookUrl.replace(/\/$/, '')}/${id}` : '');
  const copyTunnel = () => { void window.cth.copyToClipboard(tunnelUrl); };

  // --- Organisation trigger handlers ---
  /** Same contract as webhooks: mirror first (so the Triggers tab is live), then
   *  persist. Keystroke edits pass `persist: false` and commit on blur. */
  const applyOrg = async (next: OrgTriggerConfig, persist = true) => {
    setOrgTriggerStore(next);
    if (!persist) return;
    setOrgBusy(true); setOrgNote('');
    try {
      const res = await triggersApi().setOrgTrigger(next);
      if (res && res.ok === false) { setOrgNote(res.error ?? '保存できませんでした'); return; }
      setOrgNote('保存しました');
      setTimeout(() => setOrgNote(''), 1500);
    } catch (e) {
      setOrgNote(e instanceof Error ? e.message : String(e));
    } finally { setOrgBusy(false); }
  };

  // --- Free Flow handlers ---
  /** Persist Free Flow settings; main re-arms the global hotkey. Also mirror the
   *  flag into the store so the composer mic button appears/disappears live. */
  const saveFreeflow = async (enabledOverride?: boolean) => {
    const enabled = enabledOverride ?? freeflowEnabled;
    setFreeflowBusy(true); setFreeflowNote('');
    try {
      await window.cth.freeflowSetConfig({
        enabled,
        apiKey: groqKey,
        model: freeflowModel.trim() || 'whisper-large-v3-turbo'
      });
      setFreeflowEnabledStore(enabled);
      // Mirror boolean key-presence so the voice button enables/disables live
      // without an app restart (presence only — never the key value).
      setHasGroqKeyStore(!!groqKey.trim());
      setFreeflowNote('保存しました');
    } catch (e) {
      setFreeflowNote(e instanceof Error ? e.message : String(e));
    } finally { setFreeflowBusy(false); }
  };

  /** Toggle on/off and persist immediately so the change takes effect (and the
   *  global hotkey arms/disarms) without a separate Save click. */
  const toggleFreeflow = () => {
    const next = !freeflowEnabled;
    setFreeflowEnabled(next);
    void saveFreeflow(next);
  };

  const reset = async () => {
    setBusy(true);
    clearLocalState();
    // Wipes hive + palace, resets config, and relaunches into onboarding.
    // The app exits, so this never resolves - no need to clear `busy`.
    await window.cth.resetAll();
  };

  // --- Change home folder ---
  /** Pick a new folder, then open the move-vs-fresh sub-modal. */
  const pickNewHome = async () => {
    setChangeErr('');
    const res = await window.cth.chooseFolder();
    if (!res.ok) return; // cancelled - no-op
    setChangeMode('move'); // recommended default
    setChangeHome(res.path);
  };

  /** Apply the home-folder change. On success the app relaunches (never resolves);
   *  on failure we surface the error and the existing home keeps running. */
  const applyChangeHome = async () => {
    if (!changeHome) return;
    setChangeBusy(true); setChangeErr('');
    // Moving copies the hive (incl. its .git) + palace, so the new home owns the
    // same renderer-side roster - keep localStorage. A 'fresh' home starts empty,
    // so clear the renderer cache to match.
    if (changeMode === 'fresh') clearLocalState();
    try {
      const res = await window.cth.changeHome(changeHome, changeMode);
      if (!res.ok) { setChangeErr(res.error ?? 'ホームフォルダを変更できませんでした。'); setChangeBusy(false); }
      // ok === true never returns (the process relaunches).
    } catch (e) {
      setChangeErr(e instanceof Error ? e.message : String(e));
      setChangeBusy(false);
    }
  };

  const modalTitle = changeHome
    ? 'ホームフォルダの変更'
    : confirming
      ? 'すべてリセットしますか？'
      : '設定';

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 300
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 840, maxWidth: '92vw', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          filter: 'drop-shadow(4px 4px 0 rgba(26, 19, 32, 0.25))'
        }}
      >
        <PixelPanel
          variant="dialog"
          title={modalTitle}
          noPadding
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', maxHeight: '88vh' }}
        >
          {/* === Change home sub-modal === */}
          {changeHome ? (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>新しいホームフォルダ</span>
                <code style={{
                  fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 12,
                  color: 'var(--cth-ink-900)', wordBreak: 'break-all'
                }}>{changeHome}</code>
              </div>

              {/* Move vs. fresh - two selectable option rows; move is preselected. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {([
                  ['move', '既存データを移行する（推奨）', 'このハーネスのハイブ（全エージェント・メモリ・タスク）とセマンティックメモリのパレスを新しいフォルダにコピーします。旧フォルダはバックアップとしてそのまま残り、後で削除できます。'],
                  ['fresh', '新しく始める', 'ハーネスを新しい（空の）フォルダに向けます。既存データは旧フォルダに残ったまま使われません。']
                ] as const).map(([value, title, desc]) => {
                  const selected = changeMode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setChangeMode(value)}
                      disabled={changeBusy}
                      style={{
                        textAlign: 'left', cursor: changeBusy ? 'default' : 'pointer',
                        padding: '10px 12px', background: 'var(--cth-paper-100)', border: 'none',
                        boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${selected ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                        display: 'flex', flexDirection: 'column', gap: 3
                      }}
                    >
                      <span style={{
                        fontSize: 13, lineHeight: '20px',
                        color: 'var(--cth-ink-900)', fontWeight: selected ? 700 : 400
                      }}>
                        {selected ? '◉ ' : '○ '}{title}
                      </span>
                      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{desc}</span>
                    </button>
                  );
                })}
              </div>

              {changeErr && (
                <div style={{ fontSize: 12, lineHeight: '18px', color: '#6E1423' }}>{changeErr}</div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="secondary" size="md" onClick={() => { setChangeHome(null); setChangeErr(''); }} disabled={changeBusy}>
                  キャンセル
                </PixelButton>
                <PixelButton variant="primary" size="md" onClick={applyChangeHome} disabled={changeBusy}>
                  {changeBusy ? '適用中...' : (changeMode === 'move' ? '移行して再起動' : '切り替えて再起動')}
                </PixelButton>
              </div>
            </div>

          /* === Reset confirmation screen === */
          ) : confirming ? (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{
                  width: 32, height: 32,
                  background: 'var(--cth-coral-light)',
                  boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0
                }}>
                  <Icon name="bell" />
                </div>
                <div style={{ flex: 1, fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                  Michaelの全メモリとハイブ全体が完全に消去され、元に戻せません。
                  実行中のセッションは終了され、アプリはオンボーディングから再起動します。
                  本当によろしいですか？
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="secondary" size="md" onClick={() => setConfirming(false)} disabled={busy}>
                  キャンセル
                </PixelButton>
                <PixelButton variant="destructive" size="md" onClick={reset} disabled={busy}>
                  {busy ? 'リセット中...' : 'すべて消去して再起動'}
                </PixelButton>
              </div>
            </div>

          /* === Main two-pane settings layout === */
          ) : (
            <>
              <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

                {/* Left nav */}
                <div style={{
                  width: 160, flexShrink: 0,
                  display: 'flex', flexDirection: 'column',
                  borderRight: '2px solid var(--cth-ink-300)',
                  paddingTop: 8, paddingBottom: 8,
                  background: 'var(--cth-cream-200)'
                }}>
                  {NAV_SECTIONS.map((section) => {
                    const active = activeSection === section;
                    return (
                      <button
                        key={section}
                        type="button"
                        onClick={() => setActiveSection(section)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '10px 16px 8px',
                          border: 'none',
                          borderLeft: active ? '3px solid var(--cth-lemon)' : '3px solid transparent',
                          background: active ? 'var(--cth-ink-900)' : 'transparent',
                          color: active ? 'var(--cth-cream-50)' : 'var(--cth-ink-700)',
                          fontFamily: 'var(--cth-font-display)',
                          fontSize: 8,
                          lineHeight: '12px',
                          cursor: 'pointer',
                          letterSpacing: 0
                        }}
                      >
                        {section}
                      </button>
                    );
                  })}
                </div>

                {/* Right scrollable content pane. minWidth:0 lets this flex child
                    shrink to the row's width instead of growing to its content's
                    min-content (which would push a horizontal scrollbar). */}
                <div style={{
                  flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden',
                  padding: '20px 24px',
                  display: 'flex', flexDirection: 'column', gap: 20
                }}>

                  {/* GENERAL */}
                  {activeSection === 'General' && (
                    <>
                      {/* Who you are and what this install is — version, plan,
                          sponsor, and the app-level actions that belong to none
                          of the settings below. Slots for a future subscription
                          and a sponsor live here; both render nothing until set. */}
                      <SettingsHeroCard />

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Updates — first among the settings proper, because "am I
                          on the latest?" is the question people open Settings to
                          answer, and the toolbar chip says nothing at all when
                          the answer is yes. */}
                      <UpdatesSection />

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Home folder */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          ホームフォルダ
                        </div>
                        <div style={{ display: 'flex', gap: 12, fontSize: 13, lineHeight: '20px', alignItems: 'center' }}>
                          <span style={{
                            flex: 1, color: 'var(--cth-ink-900)', wordBreak: 'break-all',
                            fontFamily: 'var(--cth-font-mono, monospace)'
                          }}>{config.harnessHome ?? '—'}</span>
                          <PixelButton variant="secondary" size="sm" onClick={pickNewHome}>変更...</PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Environment — settings that used to be trapped in onboarding */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          環境
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>エージェント実行中はMacをスリープさせない</span>
                              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                                ディスプレイのスリープを防ぎ、スケジュールやターミナルが時間通りに動き続けます。バッテリーを消費するため、電源接続時がおすすめです。
                              </span>
                            </div>
                            <PixelButton variant={keepAwake ? 'primary' : 'secondary'} size="sm" onClick={toggleKeepAwake}>
                              {keepAwake ? 'オン' : 'オフ'}
                            </PixelButton>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>かんたん説明モード</span>
                              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                                エージェントが専門用語のかたまりではなく、平易な言葉で報告します。
                              </span>
                            </div>
                            <PixelButton variant={simpleMode ? 'primary' : 'secondary'} size="sm" onClick={toggleSimpleMode}>
                              {simpleMode ? 'オン' : 'オフ'}
                            </PixelButton>
                          </div>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Desktop notifications toggle */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          通知
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              デスクトップ通知
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              エージェントの完了時や入力が必要なときにネイティブ通知を表示します。
                            </span>
                          </div>
                          <PixelButton
                            variant={notifications ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleNotifications}
                          >
                            {notifications ? 'オン' : 'オフ'}
                          </PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Scheduled auto-compact (compact-maintenance mission) */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          メンテナンス
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              定期自動コンパクト
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              スケジュールに従って全エージェントに /compact を発行します（既定は1時間ごと。間隔はTriggersタブで設定）。
                              既定でオフ — 長時間稼働のエージェントはコンテキストがあふれる可能性があります。
                            </span>
                          </div>
                          <PixelButton
                            variant={autoCompactOn ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleAutoCompact}
                          >
                            {autoCompactOn ? 'オン' : 'オフ'}
                          </PixelButton>
                        </div>
                        <div style={{ height: 10 }} />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              自動アップデート
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              GitHubのリリースを確認し、バックグラウンドでアップデートをダウンロードします。
                              再起動のタイミングは自分で選択。勝手に再起動することはありません。
                            </span>
                          </div>
                          <PixelButton
                            variant={autoUpdateOn ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleAutoUpdate}
                          >
                            {autoUpdateOn ? 'オン' : 'オフ'}
                          </PixelButton>
                        </div>
                        <div style={{ height: 10 }} />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              匿名使用統計
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              匿名のイベント（アプリ起動、エージェント起動、機能の使用など）を少数送信します —
                              プロンプト・コード・パス・エージェント出力は一切含まれません。詳細はTELEMETRY.mdを参照。
                            </span>
                          </div>
                          <PixelButton
                            variant={telemetryOn ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleTelemetry}
                          >
                            {telemetryOn ? 'オン' : 'オフ'}
                          </PixelButton>
                        </div>
                      </div>

                      {/* Office Theme — TV-show office maps (experimental; flag tvShowOffices, default off) */}
                      <OfficeThemePicker config={config} />
                    </>
                  )}

                  {/* AGENTS & MODELS — what powers the office */}
                  {/* PREREQUISITES — the external tools the app leans on and
                      whether this machine has them. It was a Command Center tab,
                      which was the wrong home: it is machine-wide state, not
                      something about the agent whose terminal you are reading. */}
                  {activeSection === 'Prerequisites' && <SetupPanel onDone={onClose} />}

                  {activeSection === 'Agents & Models' && (
                    <>
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          デフォルトのエージェントモデル
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                            新しく起動されるClaudeエージェント（Michael本人を含む）は、個別に指定しない限りこのモデルで開始します。
                            モデルピッカーでは「· default」と表示されます。
                          </span>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {AGENT_MODELS.map((m) => (
                              <button
                                key={m.label}
                                onClick={() => { if (m.id) void saveDefaultModel(m.id); }}
                                style={{
                                  padding: '3px 8px 1px', border: 'none', cursor: 'pointer',
                                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                                  background: defaultModelSel === m.id ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
                                  boxShadow: defaultModelSel === m.id ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)'
                                }}
                              >{m.label}</button>
                            ))}
                          </div>
                          {defaultModelNote && <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{defaultModelNote}</span>}
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      <AiEnginesSettings config={config} />

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Advanced */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          詳細
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 13, color: 'var(--cth-ink-900)' }}>1実行あたりの最大ターン数</span>
                          <input
                            type="number" min="1" step="10" value={maxTurnsVal}
                            onChange={(e) => setMaxTurnsVal(e.target.value)}
                            onBlur={() => void saveMaxTurns()}
                            placeholder="無制限"
                            style={{ ...slackInputStyle, width: 120 }}
                          />
                          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>空欄 = 無制限</span>
                        </div>
                      </div>
                    </>
                  )}

                  {/* AUTONOMY & BUDGETS — the safety tab */}
                  {activeSection === 'Autonomy & Budgets' && (
                    <>
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          自律性
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              {autoModeOn ? '自律モード — エージェントが確認なしで行動' : '承認制 — エージェントはツール実行前に確認'}
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              新しく起動するエージェントに適用されます（各エージェントのコマンドで個別に上書き可能）。
                            </span>
                          </div>
                          <PixelButton variant={autoModeOn ? 'primary' : 'secondary'} size="sm" onClick={toggleAutoMode}>
                            {autoModeOn ? '自律' : '承認制'}
                          </PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)', margin: '12px 0' }} />

                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              エージェントを追加できる相手
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {orchSpawnOn
                                ? 'Michaelが自分の判断でエージェントを採用します。彼が起動したエージェントはあなたが承認していないトークンを消費します。'
                                : 'あなただけです。Michaelは引き続き依頼でき、そのリクエストは失敗せずキューで待機します。'}
                            </span>
                          </div>
                          <PixelButton variant={orchSpawnOn ? 'primary' : 'secondary'} size="sm" onClick={toggleOrchSpawn}>
                            {orchSpawnOn ? '自分とMichael' : '自分だけ'}
                          </PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Circuit breaker — the FULL unit (v0.3.4: all fields have UI) */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          サーキットブレーカー
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              暴走するエージェントと出費から守ります。ブレーカーはしきい値を超えたエージェントを、まず誘導し、次に制限し、最後に停止させます。
                            </span>
                            <PixelButton variant={brkEnabled ? 'primary' : 'secondary'} size="sm"
                              onClick={() => { setBrkEnabled(!brkEnabled); }}>
                              {brkEnabled ? 'オン' : 'オフ'}
                            </PixelButton>
                          </div>
                          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              トークン予算の下限
                              <input
                                type="number" min="0" step="100000" value={agentBudget}
                                onChange={(e) => setAgentBudget(e.target.value)}
                                placeholder="例: 1000000"
                                style={{ ...slackInputStyle, width: 180 }}
                              />
                              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                                {fmtBudgetTokens(agentBudget) ? `= ${fmtBudgetTokens(agentBudget)} トークン` : '下限全体での合計トークン数'}
                              </span>
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              トークン速度（トークン/分）
                              <input
                                type="number" min="0" step="1000" value={velocityCeiling}
                                onChange={(e) => setVelocityCeiling(e.target.value)}
                                placeholder="例: 200000"
                                style={{ ...slackInputStyle, width: 180 }}
                              />
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              同一ツール連続実行の上限
                              <input
                                type="number" min="0" step="5" value={brkRepeated}
                                onChange={(e) => setBrkRepeated(e.target.value)}
                                placeholder="既定値"
                                style={{ ...slackInputStyle, width: 140 }}
                              />
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              エラーストームの上限
                              <input
                                type="number" min="0" step="5" value={brkErrStorm}
                                onChange={(e) => setBrkErrStorm(e.target.value)}
                                placeholder="既定値"
                                style={{ ...slackInputStyle, width: 140 }}
                              />
                            </label>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>強制停止</span>
                              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                                発動時にエージェントを制限ではなく強制終了させます。オフ = 誘導を優先（推奨）。
                              </span>
                            </div>
                            <PixelButton variant={brkHardStop ? 'destructive' : 'secondary'} size="sm"
                              onClick={() => { setBrkHardStop(!brkHardStop); }}>
                              {brkHardStop ? '発動時に強制停止' : '誘導を優先'}
                            </PixelButton>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <PixelButton variant="secondary" size="sm" onClick={saveBudget}>保存</PixelButton>
                            {budgetNote && <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{budgetNote}</span>}
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {/* MEMORY & KNOWLEDGE */}
                  {activeSection === 'Memory & Knowledge' && (
                    <>
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          セマンティックメモリ
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>セッション横断の記憶</span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              エージェントのMarkdownメモリをインデックス化し、即時検索できるようにします。埋め込みモデルはメモリパネルで設定します。
                            </span>
                          </div>
                          <PixelButton variant={semMemOn ? 'primary' : 'secondary'} size="sm" onClick={toggleSemMem}>
                            {semMemOn ? 'オン' : 'オフ'}
                          </PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Knowledge Graph — enterprise multimodal context for agents */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          ナレッジグラフ
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              エンタープライズナレッジベース
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              ドキュメント・画像・PDFを追加すると、エージェントが <code>kg</code> ツール経由で必要に応じて照会します。
                            </span>
                          </div>
                          <PixelButton
                            variant={kgEnabled ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleKg}
                          >
                            {kgEnabled ? 'オン' : 'オフ'}
                          </PixelButton>
                        </div>
                        {kgEnabled && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                            <PixelButton variant="secondary" size="sm" onClick={addKgFiles} disabled={kgBusy}>
                              {kgBusy ? '追加中…' : 'ファイルを追加…'}
                            </PixelButton>
                            <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                              インデックス済みドキュメント: {kgDocCount} 件
                            </span>
                            {kgNote && <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{kgNote}</span>}
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {/* CONNECTIONS — everything external (MCP + Slack + webhook + REST) */}
                  {activeSection === 'Connections' && (
                    <>
                      <McpDefaultsSettings config={config} />
                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />
                    </>
                  )}

                  {activeSection === 'Connections' && (
                    <>
                      {/* Connected-services registry (generic, registry-driven).
                          Leads the section; the hardcoded Slack/Webhook/Free Flow
                          blocks below stay as-is. */}
                      <IntegrationsRegistry />

                      <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

                      {/* Slack integration */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
                        }}>
                          Slack
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              Slack連携
                              {/* i - toggles the step-by-step connect guide. */}
                              <button
                                type="button"
                                aria-label="Slack接続手順を表示"
                                aria-expanded={showSlackHelp}
                                onClick={() => setShowSlackHelp((v) => !v)}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                  width: 16, height: 16, padding: 0, cursor: 'pointer',
                                  border: 'none', borderRadius: '50%',
                                  background: showSlackHelp ? 'var(--cth-ink-700)' : 'var(--cth-ink-300)',
                                  color: showSlackHelp ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
                                  fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px'
                                }}
                              >i</button>
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              SlackチャンネルのメッセージをMichaelのキューに直接流し込みます。
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {/* Connection status: clear, always-visible. */}
                            <span style={{
                              fontSize: 12, lineHeight: '16px',
                              color: running ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-ink-500)'
                            }}>
                              {running ? '● 接続済み' : '○ 未接続'}
                            </span>
                            <PixelButton
                              variant={slackEnabled ? 'primary' : 'secondary'}
                              size="sm"
                              onClick={() => setSlackEnabled((v) => !v)}
                            >
                              {slackEnabled ? 'オン' : 'オフ'}
                            </PixelButton>
                          </div>
                        </div>

                        {/* Step-by-step connect guide. Includes the both-lists
                            bot-event subscription requirement (steps 6 & 7). */}
                        {showSlackHelp && (
                          <pre style={{
                            margin: 0, padding: 10, whiteSpace: 'pre-wrap',
                            background: 'var(--cth-paper-100)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '16px',
                            color: 'var(--cth-ink-700)'
                          }}>{SLACK_CONNECT_STEPS}</pre>
                        )}

                        {slackEnabled && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {/* Signing secret + bot token side-by-side in the wider layout */}
                            <div style={{ display: 'flex', gap: 16 }}>
                              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                                <span style={slackLabelStyle}>シグニングシークレット</span>
                                <input
                                  type="password"
                                  value={slackSecret}
                                  onChange={(e) => setSlackSecret(e.target.value)}
                                  placeholder="Slackアプリ -> Basic Information -> Signing Secret"
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                              </label>
                              {/* Bot token: stays in main; never leaves the main process. */}
                              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                                <span style={slackLabelStyle}>ボットトークン</span>
                                <input
                                  type="password"
                                  value={slackBotToken}
                                  onChange={(e) => setSlackBotToken(e.target.value)}
                                  placeholder="xoxb-..."
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                              </label>
                            </div>

                            <div style={{ display: 'flex', gap: 16 }}>
                              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                                <span style={slackLabelStyle}>チャンネルID（任意）</span>
                                <input
                                  value={slackChannel}
                                  onChange={(e) => setSlackChannel(e.target.value)}
                                  placeholder="C0123... または空欄ですべて"
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                              </label>
                              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 100 }}>
                                <span style={slackLabelStyle}>ポート</span>
                                <input
                                  type="number"
                                  value={slackPort}
                                  onChange={(e) => setSlackPort(e.target.value)}
                                  placeholder="3847"
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                              </label>
                            </div>

                            {/* App/voice-INITIATED proactive posting — OFF by
                                default ("stop posting into Slack by default").
                                Gates ONLY the renderer's "queued" ack; the
                                Slack-ORIGIN done-reply round-trip is never gated. */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                              <span style={slackLabelStyle}>
                                プロアクティブ投稿（アプリ起点）— 既定でオフ
                              </span>
                              <PixelButton
                                variant={slackProactivePosting ? 'primary' : 'secondary'}
                                size="sm"
                                onClick={() => setSlackProactivePosting((v) => !v)}
                              >
                                {slackProactivePosting ? 'オン' : 'オフ'}
                              </PixelButton>
                            </div>

                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              {/* Start disabled once connected; Stop only when running. */}
                              <PixelButton variant="primary" size="sm" onClick={startSlack} disabled={slackBusy || !slackSecret.trim() || running}>
                                {slackBusy ? '...' : running ? '接続済み' : '開始'}
                              </PixelButton>
                              <PixelButton variant="secondary" size="sm" onClick={stopSlack} disabled={slackBusy || !running}>
                                停止
                              </PixelButton>
                              <PixelButton variant="ghost" size="sm" onClick={saveSlack} disabled={slackBusy}>
                                保存
                              </PixelButton>
                              {slackNote && (
                                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{slackNote}</span>
                              )}
                            </div>

                            {/* Keep the Request URL visible while connected even after a
                                modal reopen; when stopped, show the last URL greyed
                                since Slack reuses it until the next Start. */}
                            {(running || tunnelUrl) && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: running ? 1 : 0.55 }}>
                                <span style={slackLabelStyle}>
                                  {running
                                    ? 'Request URL - SlackのEvent Subscriptionsに貼り付けてください'
                                    : '最後のRequest URL - 停止するまでSlackはこれを再利用します'}
                                </span>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <input
                                    readOnly
                                    value={tunnelUrl}
                                    onFocus={(e) => e.currentTarget.select()}
                                    style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}
                                  />
                                  <PixelButton variant="secondary" size="sm" onClick={copyTunnel} disabled={!tunnelUrl}>コピー</PixelButton>
                                </div>
                              </div>
                            )}

                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              Slackアプリ側でEvent Subscriptionsを有効にし、{' '}
                              <code>message.channels</code> / <code>message.groups</code> のボットイベントを追加して、
                              上のRequest URLを設定し、ワークスペースに再インストールしてください。トンネルURLは再起動のたびに
                              変わるため、再度Startを押した後は貼り付け直してください。
                            </span>
                          </div>
                        )}
                      </div>

                      <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

                      {/* Webhook triggers — a LIST of endpoints, one per caller.
                          Everything renders off the store mirror, so a change made
                          in the Triggers tab lands here without a refetch (and the
                          other way round). */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
                        }}>
                          Webhookトリガー
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              Webhookトリガー
                              <button
                                type="button"
                                aria-label="Webhook API形式を表示"
                                aria-expanded={showWebhookHelp}
                                onClick={() => setShowWebhookHelp((v) => !v)}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                  width: 16, height: 16, padding: 0, cursor: 'pointer',
                                  border: 'none', borderRadius: '50%',
                                  background: showWebhookHelp ? 'var(--cth-ink-700)' : 'var(--cth-ink-300)',
                                  color: showWebhookHelp ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
                                  fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px'
                                }}
                              >i</button>
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              呼び出し元ごとに1つのエンドポイントを持ち、それぞれ固有のシークレットとモードを備えます。
                              すべて同一のサーバーを共有するため、Webhookを追加してもコストはかかりません。
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{
                              fontSize: 12, lineHeight: '16px',
                              color: webhookRunning ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-ink-500)'
                            }}>
                              {webhookRunning ? '● 待ち受け中' : '○ 待ち受けなし'}
                            </span>
                            <PixelButton variant="primary" size="sm" onClick={addWebhook} disabled={webhookBusy}>
                              Webhookを追加
                            </PixelButton>
                          </div>
                        </div>

                        {showWebhookHelp && (
                          <pre style={{
                            margin: 0, padding: 10, whiteSpace: 'pre-wrap',
                            background: 'var(--cth-paper-100)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '16px',
                            color: 'var(--cth-ink-700)'
                          }}>{WEBHOOK_API_DOC}</pre>
                        )}

                        {/* Public surface warning. Loud, not buried. */}
                        <span style={{ fontSize: 12, lineHeight: '16px', color: '#6E1423' }}>
                          有効にしたWebhookは、シークレットを知る誰もがPOSTできる公開エンドポイントになります。
                          新規作成時はオフで追加されます。
                        </span>

                        {webhookTriggers.length === 0 ? (
                          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                            Webhookはまだありません。ツールに仕事を渡せるURLを与えるには1つ追加してください。
                          </span>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {webhookTriggers.map((w) => {
                              const shown = shownSecrets[w.id] === true;
                              const endpoint = webhookEndpoint(w.id);
                              const modeBlurb = TRIGGER_MODES.find((m) => m.value === w.mode)?.blurb ?? '';
                              return (
                                <div
                                  key={w.id}
                                  style={{
                                    display: 'flex', flexDirection: 'column', gap: 8,
                                    padding: '10px 12px',
                                    background: 'var(--cth-cream-100)',
                                    boxShadow: `inset 0 0 0 ${w.enabled ? 1.5 : 1}px ${w.enabled ? 'var(--cth-ink-500)' : 'var(--cth-ink-100)'}`
                                  }}
                                >
                                  {/* Name, on/off, delete. Renaming is live in the
                                      mirror on every keystroke and persists on blur. */}
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <input
                                      value={w.name}
                                      onChange={(e) => { void patchWebhook(w.id, { name: e.target.value }, false); }}
                                      onBlur={() => { void applyWebhooks(webhookTriggers); }}
                                      placeholder="呼び出し元の名前"
                                      style={{ ...slackInputStyle, flex: 1 }}
                                    />
                                    <PixelButton
                                      variant={w.enabled ? 'primary' : 'secondary'}
                                      size="sm"
                                      onClick={() => { void patchWebhook(w.id, { enabled: !w.enabled }); }}
                                      disabled={webhookBusy}
                                    >
                                      {w.enabled ? 'オン' : 'オフ'}
                                    </PixelButton>
                                    {/* Two clicks: deleting revokes a caller's access for good. */}
                                    <PixelButton
                                      variant={pendingDelete === w.id ? 'destructive' : 'ghost'}
                                      size="sm"
                                      onClick={() => {
                                        if (pendingDelete === w.id) void removeWebhook(w.id);
                                        else setPendingDelete(w.id);
                                      }}
                                      disabled={webhookBusy}
                                    >
                                      {pendingDelete === w.id ? '本当に？' : '削除'}
                                    </PixelButton>
                                  </div>

                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <span style={{ ...slackLabelStyle, width: 56, flexShrink: 0 }}>URL</span>
                                    <input
                                      readOnly
                                      value={endpoint || 'Webhookサーバーが待ち受けを開始すると表示されます'}
                                      onFocus={(e) => e.currentTarget.select()}
                                      style={{
                                        ...slackInputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                                        color: endpoint ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
                                      }}
                                    />
                                    <PixelButton
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => { void window.cth.copyToClipboard(endpoint); }}
                                      disabled={!endpoint}
                                    >
                                      コピー
                                    </PixelButton>
                                  </div>

                                  {/* Masked by default; never in a title attribute. */}
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <span style={{ ...slackLabelStyle, width: 56, flexShrink: 0 }}>シークレット</span>
                                    <input
                                      type={shown ? 'text' : 'password'}
                                      readOnly
                                      value={w.secret}
                                      onFocus={(e) => e.currentTarget.select()}
                                      style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                    />
                                    <PixelButton
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => setShownSecrets((s) => ({ ...s, [w.id]: !shown }))}
                                    >
                                      {shown ? '隠す' : '表示'}
                                    </PixelButton>
                                    <PixelButton
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => { void window.cth.copyToClipboard(w.secret); }}
                                    >
                                      コピー
                                    </PixelButton>
                                    <PixelButton
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => { void rotateWebhookSecret(w.id); }}
                                      disabled={webhookBusy}
                                    >
                                      再生成
                                    </PixelButton>
                                  </div>

                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <span style={{ ...slackLabelStyle, width: 56, flexShrink: 0 }}>モード</span>
                                    <select
                                      value={w.mode}
                                      onChange={(e) => { void patchWebhook(w.id, { mode: e.target.value as TriggerMode }); }}
                                      style={{ ...slackInputStyle, width: 160, flexShrink: 0 }}
                                    >
                                      {TRIGGER_MODES.map((m) => (
                                        <option key={m.value} value={m.value}>{m.label}</option>
                                      ))}
                                    </select>
                                    <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                                      {modeBlurb}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                          呼び出し元はWebhookのURLに対し、シークレットを{' '}
                          <code>x-md-webhook-secret</code> ヘッダーに入れてPOSTします。それぞれのWebhookは独自のJSON
                          スキーマでbodyを検証します — Michael's Command Center のTriggersタブで編集できます。
                          到着したすべての履歴もそこにあります。
                        </span>

                        {webhookNote && (
                          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{webhookNote}</span>
                        )}
                      </div>

                      <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

                      {/* Organisation trigger — teammates messaging this clone node.
                          Persisted + mirrored; no transport reads the key yet. */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
                        }}>
                          組織
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              組織キー
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              チームメイトの環境がこの環境を参照するための識別子です。
                            </span>
                          </div>
                          <PixelButton
                            variant={orgTrigger.enabled ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={() => { void applyOrg({ ...orgTrigger, enabled: !orgTrigger.enabled }); }}
                            disabled={orgBusy}
                          >
                            {orgTrigger.enabled ? 'オン' : 'オフ'}
                          </PixelButton>
                        </div>

                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={slackLabelStyle}>APIキー</span>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input
                              type={showOrgKey ? 'text' : 'password'}
                              value={orgTrigger.apiKey}
                              onChange={(e) => { void applyOrg({ ...orgTrigger, apiKey: e.target.value }, false); }}
                              onBlur={() => { void applyOrg(orgTrigger); }}
                              placeholder="組織キーを貼り付け"
                              style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                            />
                            <PixelButton
                              variant="secondary"
                              size="sm"
                              onClick={() => setShowOrgKey((v) => !v)}
                              disabled={!orgTrigger.apiKey}
                            >
                              {showOrgKey ? '隠す' : '表示'}
                            </PixelButton>
                          </div>
                        </label>

                        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                          {CLONE_NODE_BLURB}
                        </span>

                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 200 }}>
                          <span style={slackLabelStyle}>モード</span>
                          <select
                            value={orgTrigger.mode}
                            onChange={(e) => { void applyOrg({ ...orgTrigger, mode: e.target.value as TriggerMode }); }}
                            style={slackInputStyle}
                          >
                            {TRIGGER_MODES.map((m) => (
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </select>
                        </label>
                        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                          {TRIGGER_MODES.find((m) => m.value === orgTrigger.mode)?.blurb ?? ''}
                        </span>

                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <PixelButton variant="ghost" size="sm" onClick={() => { void applyOrg(orgTrigger); }} disabled={orgBusy}>
                            保存
                          </PixelButton>
                          {orgNote && (
                            <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{orgNote}</span>
                          )}
                        </div>

                        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                          現在は設定の保存のみです。組織間メッセージングサービスはまだ存在しないため、ここでキーを
                          入力しても通信は開始されません — 保存され、Triggersタブに表示され、待機します。
                        </span>
                      </div>

                    </>
                  )}

                  {/* VOICE — Free Flow dictation + Realtime Michael (v0.3.4: its own tab) */}
                  {activeSection === 'Voice' && (
                    <>
                      {/* Free Flow (voice dictation) */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
                        }}>
                          Free Flow
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              Free Flow（音声入力）
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              押して話す音声入力：話しかけるとGroq Whisperがテキストをキューコンポーザーに入力します。
                            </span>
                          </div>
                          <PixelButton
                            variant={freeflowEnabled ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleFreeflow}
                            disabled={freeflowBusy}
                          >
                            {freeflowEnabled ? 'オン' : 'オフ'}
                          </PixelButton>
                        </div>

                        {freeflowEnabled && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {/* Groq API key — stored in main config, used only there. */}
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span style={slackLabelStyle}>Groq APIキー</span>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                  type={showGroqKey ? 'text' : 'password'}
                                  value={groqKey}
                                  onChange={(e) => setGroqKey(e.target.value)}
                                  placeholder="gsk_...（console.groq.comで無料キーを取得できます）"
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                                <PixelButton variant="secondary" size="sm" onClick={() => setShowGroqKey((v) => !v)} disabled={!groqKey}>
                                  {showGroqKey ? '隠す' : '表示'}
                                </PixelButton>
                              </div>
                            </label>

                            {/* Model picker */}
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 280 }}>
                              <span style={slackLabelStyle}>モデル</span>
                              <select
                                value={freeflowModel}
                                onChange={(e) => setFreeflowModel(e.target.value)}
                                style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                              >
                                <option value="whisper-large-v3-turbo">whisper-large-v3-turbo（高速）</option>
                                <option value="whisper-large-v3">whisper-large-v3（高精度）</option>
                              </select>
                            </label>

                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <PixelButton variant="ghost" size="sm" onClick={() => saveFreeflow()} disabled={freeflowBusy}>
                                保存
                              </PixelButton>
                              {freeflowNote && (
                                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{freeflowNote}</span>
                              )}
                            </div>

                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              音声入力は2つの方法：キューコンポーザーのSendの上にあるマイクボタンをクリック（クリックで録音、
                              もう一度クリックで文字起こし）、または任意のエージェントのターミナル表示中に{' '}
                              <strong>Option（⌥）を押しながら</strong>話し、離すと文字起こし。どちらもテキストは送信前に
                              確認できるようコンポーザー下書きに入ります。初回録音時にmacOSがマイクの権限を求めます。
                            </span>
                          </div>
                        )}
                      </div>

                      <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

                      {/* Realtime Michael — voice device selection (rt-8) */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
                        }}>
                          Realtime Michael
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                            Michaelと音声チャット
                          </span>
                          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                            オーケストレーターとリアルタイムで会話します。Michaelのタブからオンにできます。ここでは
                            音声ループが使うマイクとスピーカーを選択します。
                          </span>
                        </div>

                        {/* OpenAI Realtime key — settable HERE, not just described here.
                            This is where someone looking for voice actually lands (the Talk
                            button deep-links to it), so sending them to another tab to type
                            the key was a dead end dressed up as documentation. Same broker
                            slot as Agents & Models (apikey:openai) — one key, two doorways,
                            and saving in either flips the same gate. The value never leaves
                            main; only the presence boolean comes back. */}
                        <div style={{
                          display: 'flex', flexDirection: 'column', gap: 8,
                          padding: 10,
                          background: 'var(--cth-paper-100)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                        }}>
                          <span style={{
                            fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                            color: 'var(--cth-ink-500)', textTransform: 'uppercase'
                          }}>
                            OpenAI APIキー · 音声
                          </span>
                          <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
                            Michaelとの会話はOpenAIのRealtime APIで動作します — 音声入力から音声出力まで、{' '}
                            <strong style={{ fontFamily: 'var(--cth-font-mono)' }}>{REALTIME_MODEL}</strong> への
                            ライブ接続を使用します。これはエージェントが動いているClaudeサブスクリプションとは別の
                            サービスなので、専用の <strong>OpenAI APIキー</strong> が必要です。
                          </span>
                          <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
                            下に一度貼り付けるだけです。このマシン上で暗号化され、二度と表示されません — 各音声
                            セッションはキーから短命トークンを発行するだけで、キー本体がPCの外に出ることはありません。
                            <strong>Agents &amp; Models</strong> に表示されているものと同じOpenAIキーであり、
                            どちらか片方で設定すれば十分です。
                          </span>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              type="password"
                              value={openAiVoiceKey}
                              onChange={(e) => setOpenAiVoiceKey(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') void saveOpenAiVoiceKey(); }}
                              placeholder={hasOpenAiKey ? 'キー保存済み — 貼り替える場合は新しいキーを入力' : 'sk-…'}
                              style={{ ...slackInputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)' }}
                            />
                            <PixelButton
                              variant="secondary"
                              size="sm"
                              onClick={() => void saveOpenAiVoiceKey()}
                              disabled={!openAiVoiceKey.trim()}
                            >
                              保存
                            </PixelButton>
                          </div>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            fontSize: 12, lineHeight: '16px',
                            color: hasOpenAiKey ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
                          }}>
                            <span aria-hidden style={{
                              width: 8, height: 8, flexShrink: 0,
                              background: hasOpenAiKey ? 'var(--cth-mint)' : 'var(--cth-ink-300)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                            }} />
                            {openAiVoiceNote || (hasOpenAiKey
                              ? 'キーを保存しました — Talk を利用できます。Michaelのカードから開始してください。'
                              : 'キーが未設定 — 保存するまでTalkは無効のままです。')}
                          </span>
                        </div>

                        <RealtimeDevicePicker />
                        <CostHud />
                        {/* rt-9 idle-tunable: how long an idle voice session stays open before
                            it auto-closes. The spend cap remains the real runaway guard. */}
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 280 }}>
                          <span style={slackLabelStyle}>アイドル時自動切断</span>
                          <select
                            value={String(idleDisconnectMs)}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setIdleDisconnectMs(v);
                              void window.cth.updateConfig({ realtimeIdleDisconnectMs: v });
                            }}
                            style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                          >
                            <option value="30000">30秒</option>
                            <option value="60000">1分</option>
                            <option value="120000">2分</option>
                            <option value="180000">3分</option>
                            <option value="300000">5分</option>
                            <option value="600000">10分</option>
                            <option value="0">オフ（自動切断しない）</option>
                          </select>
                          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                            会話がない状態で音声セッションを開いたままにする時間です。この時間が過ぎると自動的に閉じます。
                            オフでも、使用量キャップが暴走セッションを停止させます。
                          </span>
                        </label>
                      </div>
                    </>
                  )}

                  {/* Danger — a red row at the bottom of General (was its own tab) */}
                  {activeSection === 'General' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                        color: '#6E1423'
                      }}>危険ゾーン</div>
                      <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
                        リセットすると、Michaelのメモリ、ハイブ全体（全エージェント・メッセージ・
                        タスク・ボード）、セマンティックメモリのパレス、すべての設定が消去され、
                        オンボーディングに戻ります。
                      </p>
                      <div>
                        <PixelButton variant="destructive" size="md" onClick={() => setConfirming(true)}>
                          リセットして最初から
                        </PixelButton>
                      </div>
                    </div>
                  )}

                </div>
              </div>

              {/* Footer */}
              <div style={{
                borderTop: '2px solid var(--cth-ink-300)',
                padding: '10px 16px',
                display: 'flex', justifyContent: 'flex-end',
                background: 'var(--cth-cream-50)'
              }}>
                <PixelButton variant="secondary" size="md" onClick={onClose}>閉じる</PixelButton>
              </div>
            </>
          )}
        </PixelPanel>
      </div>
    </div>
  );
}
