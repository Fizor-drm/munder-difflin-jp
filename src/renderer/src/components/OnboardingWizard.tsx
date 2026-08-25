import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon, type IconName } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import { ProviderLogo } from './ProviderLogo';
import { AGENT_PROVIDER_PRESETS, modelsForProvider, type AgentProvider, type HarnessConfig } from '@/store/config';
import { canReceiveInbox, providerPreset } from '@shared/agentProvider';
import {
  classifyEngineAvailability, engineAvailabilityBadge, engineAvailabilityMessage, engineBlocksOnboarding
} from '@shared/engineAvailability';
import type { ToolStatus } from '@shared/toolCatalog';

export interface OnboardingWizardProps {
  onComplete: (config: HarnessConfig) => void;
}

type Audience = 'technical' | 'non-technical';
type Step = 'persona' | 'welcome' | 'home' | 'orchestrator' | 'repos' | 'permissions' | 'done';

// First-run showcase — the highest-value features a brand-new user should grasp
// before any setup. Each carries a developer-register `desc` and a plain-language
// `descPlain` so the same grid speaks to both audiences (item 1).
interface Feature {
  icon: IconName;
  label: string;
  desc: string;       // technical register
  descPlain: string;  // non-technical register
  tint: string;       // tile background token
  edge: string;       // tile border token
}
const FEATURES: Feature[] = [
  {
    icon: 'mcp',
    label: '11のエンジン、1つのオフィス',
    desc: 'Claude Code、Codex、Grok、Kimi、Antigravity、Qwen、OpenCode、Crush、pi、Copilot、Cursor — 1つのフロアで動くエージェント。',
    descPlain: '11のAIアシスタント — Claude、Codex、Cursor、Gemini、Grokなど — が1つの共有オフィスで並んで作業します。',
    tint: 'var(--cth-lilac-light)', edge: 'var(--cth-lilac)'
  },
  {
    icon: 'gear',
    label: 'Michaelはあなたのクローン',
    desc: 'クローンがフロアを取り仕切ります — 依頼を仕分けし、タスクを割り当て、本当にあなたの判断が必要なものだけ持ち上げます。',
    descPlain: 'クローンのMichaelがあなたの依頼を受け、適切なエージェントへ仕事を渡します。重要な時だけあなたに連絡します。',
    tint: 'var(--cth-sky-light)', edge: 'var(--cth-sky)'
  },
  {
    icon: 'web',
    label: '長期メモリ',
    desc: '各エージェントがメモを残し、共有・検索可能なMemPalaceに蓄積します。',
    descPlain: 'エージェントは自分の作業を記憶しているので、毎回ゼロから始めません。',
    tint: 'var(--cth-mint-light)', edge: 'var(--cth-mint)'
  },
  {
    icon: 'terminal',
    label: 'コマンドセンター',
    desc: 'ターミナル・フロア・メモリ・アクティビティ・タスク・トリガーを1つの画面に。',
    descPlain: '作業状況、エージェントのメモリ、タスク、トリガーを1つのダッシュボードで確認できます。',
    tint: 'var(--cth-lemon-light)', edge: 'var(--cth-lemon)'
  },
  {
    icon: 'pause',
    label: 'ガードレール',
    desc: 'エージェントごとのトークン予算、steer→constrain→stopのサーキットブレーカー、人間による承認。',
    descPlain: '使用量の上限と安全ストップでエージェントを管理 — 大きな操作の前にあなたに確認を求めます。',
    tint: 'var(--cth-coral-light)', edge: 'var(--cth-coral)'
  },
  {
    icon: 'sparkle',
    label: 'すぐ使える採用',
    desc: 'Agent Galleryから設定済みのエージェントを選び、ワンクリックで起動できます。',
    descPlain: 'ギャラリーから用意されたエージェントをワンクリックで採用 — 設定は不要です。',
    tint: 'var(--cth-peach-light)', edge: 'var(--cth-peach)'
  }
];

// One-liner of what each engine is, shown under its row on the orchestrator step
// so a non-technical user knows what they're picking (item 3).
const PROVIDER_BLURB: Partial<Record<AgentProvider, string>> = {
  gemini: 'Gemini CLI - Google Gemini',
  claude: 'Claude Code — Anthropic',
  codex: 'Codex — OpenAI',
  antigravity: 'Antigravity — Google Gemini',
  qwen: 'Qwen — お使いのマシン上でQwenモデルをローカル実行します',
  cursor: 'Cursor Agent CLI — Cursorのクレジットを使用します(Luna、Composerなど)'
};

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>('persona');
  // Self-identified audience (item 1). Undefined until chosen on the first screen;
  // the rest of the wizard reads `plain` to swap copy registers.
  const [audience, setAudience] = useState<Audience | undefined>();
  const plain = audience === 'non-technical';

  const [home, setHome] = useState<string>('');
  const [repos, setRepos] = useState<string[]>([]);
  const [autoMode, setAutoMode] = useState<boolean>(true);
  // Anonymous usage stats (TELEMETRY.md). Default ON (opt-out); persisted by
  // finish() so unchecking before finishing means nothing is ever sent.
  const [shareStats, setShareStats] = useState<boolean>(true);
  const [godProvider, setGodProvider] = useState<AgentProvider>('claude');
  const [godModel, setGodModel] = useState<string | undefined>(
    providerPreset('claude').recommendedOrchestratorModel
  );
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Which engine CLIs are actually on this machine. The picker used to record the
  // choice blind; the first check happened when Michael spawned, and for a
  // provider with no installer that meant a first run where nothing ever booted.
  // `undefined` = probe not back yet (or failed): rows show no badge and nothing
  // is blocked, because a broken probe must not lock a new user out.
  const [engines, setEngines] = useState<ToolStatus[] | undefined>();
  const [probing, setProbing] = useState(false);
  const probeEngines = async () => {
    setProbing(true);
    try { setEngines(await window.cth.toolsStatus()); }
    catch { /* leave undefined: unknown, never blocking */ }
    finally { setProbing(false); }
  };
  useEffect(() => { void probeEngines(); }, []);
  const selectedEngine = classifyEngineAvailability(engines, godProvider);
  const engineBlocked = engineBlocksOnboarding(selectedEngine);

  // Permissions & reliability toggles. These apply IMMEDIATELY on change (their
  // own IPC / OS state) — they are NOT part of finish()'s config write. First-run
  // defaults: notifications off (config default), login-item off (fresh install);
  // each reconciles to the real state the IPC returns.
  const [strongKeepalive, setStrongKeepalive] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);

  const toggleStrongKeepalive = async (v: boolean) => {
    setStrongKeepalive(v); // optimistic
    try { setStrongKeepalive((await window.cth.updateConfig({ strongKeepalive: v })).strongKeepalive === true); }
    catch { setStrongKeepalive(!v); }
  };
  const toggleNotifications = async (v: boolean) => {
    setNotifications(v); // optimistic
    try { await window.cth.setNotifications(v); }
    catch { setNotifications(!v); } // revert on failure
  };
  const toggleOpenAtLogin = async (v: boolean) => {
    setOpenAtLogin(v); // optimistic
    try { setOpenAtLogin(await window.cth.setLoginItem(v)); } // reconcile to OS truth
    catch { setOpenAtLogin(!v); }
  };
  const openSettings = (url: string) => { void window.cth.openExternal(url); };

  // Default-suggest a sensible harness home on first render.
  //
  // This used to read `window.process.env.HOME`, which is ALWAYS undefined here:
  // the window runs with `contextIsolation: true` / `nodeIntegration: false` and
  // the preload bridges exactly one object (`cth`), so the renderer's main world
  // has no `process`. The suggestion therefore always collapsed to '' and the
  // field rendered empty — leaving the copy above promising a default the user
  // could not accept, and Finish failing with "Pick a harness home folder first."
  //
  // Suggest the literal `~/HarnessAgents` instead. That is exactly the string
  // #140's normalizeHiveHome()/expandTilde() were built to absorb: it is expanded
  // at the config-write boundary AND at ensureHarnessHome's mkdir, so every
  // downstream reader still sees one absolute path. No new IPC surface.
  useEffect(() => {
    if (!home) setHome('~/HarnessAgents');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickHome = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setHome(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  const pickRepo = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok && !repos.includes(res.path)) setRepos([...repos, res.path]);
    else if (!res.ok && res.error !== 'cancelled') setError(res.error);
  };

  const removeRepo = (path: string) => setRepos(repos.filter(r => r !== path));

  const finish = async () => {
    setBusy(true);
    setError(undefined);
    const harnessHome = home.trim(); // whitespace-only is not a folder
    if (!harnessHome) { setError('先にハーネスホームのフォルダを選択してください。'); setBusy(false); setStep('home'); return; }
    // The orchestrator step already refuses to advance on this, but a late probe
    // result can change the answer after the user has moved on. Never write a
    // godProvider that is known to be unable to boot.
    if (engineBlocked) {
      setError(`${providerPreset(godProvider).label}がインストールされていません。インストールして「再チェック」を押すか、別のエンジンを選んでください。`);
      setBusy(false); setStep('orchestrator'); return;
    }
    const ensure = await window.cth.ensureHarnessHome(harnessHome);
    if (!ensure.ok) {
      setError(ensure.error ?? 'ハーネスホームを作成できませんでした');
      setBusy(false);
      return;
    }
    const next = await window.cth.updateConfig({
      onboardingComplete: true,
      audience: audience ?? 'technical',
      harnessHome, // the same trimmed value we just mkdir'd, not the raw field
      registeredRepos: repos,
      autoMode,
      godProvider,
      godModel,
      telemetryEnabled: shareStats
    });
    setBusy(false);
    onComplete(next);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-200)',
      backgroundImage:
        `repeating-linear-gradient(45deg, rgba(232, 217, 160, 0.4) 0 1px, transparent 1px 8px)`,
      // Scroll the overlay rather than clip the wizard. Step 2 lists every
      // installed CLI engine (8 rows + a model select), which is taller than a
      // 1080p-class window once the OS chrome is subtracted — the panel was
      // being cut off at BOTH edges with no way to reach the buttons.
      display: 'flex',
      overflowY: 'auto',
      zIndex: 200,
      padding: 32
    }}>
      {/* `margin: auto` centers, NOT `align-items: center`. A centered flex item
          that overflows its container is clipped at the TOP and unreachable by
          scrolling (the overflow spills past the scroll origin); auto margins
          center while it fits and collapse to a normal scroll once it doesn't. */}
      <div style={{ width: 640, maxWidth: '94vw', margin: 'auto' }}>
        <PixelPanel
          variant="dialog"
          title={
            step === 'persona' ? 'MUNDER DIFFLINへようこそ'
            : step === 'welcome' ? 'オフィスをご紹介'
            : step === 'home' ? (plain ? 'ステップ1/4 · アプリのホームフォルダ' : 'ステップ1/4 · ハーネスホーム')
            : step === 'orchestrator' ? (plain ? 'ステップ2/4 · あなたのクローン' : 'ステップ2/4 · クローンのエンジン')
            : step === 'repos' ? (plain ? 'ステップ3/4 · プロジェクト' : 'ステップ3/4 · リポジトリ')
            : step === 'permissions' ? 'ステップ4/4 · 権限と信頼性'
            : '準備完了'
          }
          noPadding
        >
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '86vh', overflowY: 'auto' }}>

            {step === 'persona' && (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 56, height: 56, flexShrink: 0,
                    background: 'var(--cth-sky-light)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    <SpritePortrait character="michael" scale={2} />
                  </div>
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '18px' }}>
                      24時間働く、あなたのクローン
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '19px' }}>
                      Munder Difflinは、いつも使っているCLIエージェントを「あなたのクローン」に変えます。
                      長時間動き続けるエージェントのオフィスを運営し、あなたが不在の間も働き続けます。
                      コンテキスト、メモリ、タスク、トリガー、環境、ファイル、連携など、周辺的一切を管理します。
                      <span style={{ color: 'var(--cth-ink-500)' }}> すべてこのマシン上で動作します。</span>
                    </div>
                  </div>
                </div>

                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  まず — あなたはどちら？(回答に合わせて案内を調整します)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <PersonaCard
                    icon="code"
                    title="技術者です"
                    desc="コードを書く、またはターミナルで仕事をしています。CLIコマンド、フラグ、モデルIDを見せてください。"
                    selected={audience === 'technical'}
                    onClick={() => { setAudience('technical'); setError(undefined); }}
                  />
                  <PersonaCard
                    icon="sparkle"
                    title="非技術者です"
                    desc="マーケティング、営業、運用など、プログラミングは初心者です。わかりやすい言葉で説明してください。"
                    selected={audience === 'non-technical'}
                    onClick={() => { setAudience('non-technical'); setError(undefined); }}
                  />
                </div>
              </>
            )}

            {step === 'welcome' && (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{
                    width: 56, height: 56, flexShrink: 0,
                    background: 'var(--cth-sky-light)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    <SpritePortrait character="michael" scale={2} />
                  </div>
                  <div>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 12, lineHeight: '18px'
                    }}>あなたのクローンと、そのクローンが動くフロア</div>
                    <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
                      {plain
                        ? 'クローンがAIワーカーの小さなオフィスを運営し、その様子を1つの画面で見守れます。中身はこちら:'
                        : 'クローンがAIコーディングエージェントの群れを統括します — 常駐・監視可能・すべてローカル。中身はこちら:'}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {FEATURES.map((f) => (
                    <div key={f.label} style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      padding: 10,
                      background: f.tint,
                      boxShadow: `inset 0 0 0 2px ${f.edge}`
                    }}>
                      <div style={{
                        width: 28, height: 28, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'var(--cth-paper-100)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                      }}>
                        <Icon name={f.icon} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)',
                          fontSize: 10, lineHeight: '14px', marginBottom: 3
                        }}>{f.label}</div>
                        <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                          {plain ? f.descPlain : f.desc}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 'home' && (
              <>
                {plain ? (
                  <p style={{ margin: 0, lineHeight: '22px' }}>
                    アプリのホームとなる新しい空フォルダを作成してください。アプリが記憶するすべて —
                    設定やエージェントのメモリ — はここに保存されます。{' '}
                    <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                      ~/HarnessAgents
                    </code>{' '}
                    のような場所がおすすめです。存在しなければこちらで作成します。
                  </p>
                ) : (
                  <p style={{ margin: 0, lineHeight: '22px' }}>
                    ハーネスが自分のファイルを置くフォルダを選択してください — エージェントのメタデータ、ログ、
                    ここから作成した新しいリポジトリなど。{' '}
                    <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                      ~/HarnessAgents
                    </code>{' '}
                    で問題ありません。存在しなければ作成します。
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={home}
                    onChange={(e) => setHome(e.target.value)}
                    placeholder="/path/to/HarnessAgents"
                    style={inputStyle}
                  />
                  <PixelButton variant="secondary" size="md" onClick={pickHome}>
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <Icon name="folder" /> {plain ? '作成 / 選択' : '選択'}
                    </span>
                  </PixelButton>
                </div>
                <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                  {plain
                    ? '日常的にこのフォルダを開く必要はありません — アプリが記録をここに保管し、再起動しても何も失われないためのものです。'
                    : 'ここは「庁舎」のようなものです。ハーネスがエージェントの状態をここに固定するので、再起動後もセッションを再開できます。'}
                </div>
              </>
            )}

            {step === 'orchestrator' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {plain ? (
                    <><strong>Michaelはあなたのクローン</strong> — あなたの依頼を読み、タスクに分解し、
                    適切なエージェントへ渡します。フロアのボスですが、そのボスはあなたです。
                    彼を動かすAIエンジンを選んでください。</>
                  ) : (
                    <><strong>Michaelはあなたのクローン</strong> — 先ほど会ったフロアのボスです。依頼を仕分けし、
                    タスクを割り当て、チームを管理しながら、本当にあなたの判断が必要なものだけ報告してきます。
                    彼を動かすエンジンとモデルを選んでください。長いコンテキストと高性能なモデルを推奨します。</>
                  )}
                </p>

                {/* What is a CLI agent / your clone — item 3 */}
                <div style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)'
                }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="sparkle" /></span>
                  <span>
                    {plain ? (
                      <>
                      <strong>CLIエージェント</strong>とは、あなたのコンピュータ上で動くAIコーディングアシスタントです。
                      定番はClaude Code(Anthropic)、Codex(OpenAI)、Antigravity(Google Gemini)。
                      <strong>クローン</strong>は、オフィス全体を動かす常駐の存在です。
                      Claude Code(Opus 4.8・1M)を推奨します。他は後から追加・切り替えできます。</>
                    ) : (
                      <>各選択肢は<strong>CLIエンジン</strong>です(Claude Code、Codex、
                      Antigravity/Gemini、Qwenなどのローカルプロキシ)。「INSTALLED」表示のものは
                      このマシンに既にあります。「INSTALLS ON FIRST RUN」はMichael初回起動時に
                      アプリがセットアップすることを意味します。
                      <strong> クローン</strong>(Michael)は群れ全体を統括するエンジンです。
                      推奨: Claude Code · Opus 4.8 · 1M。他のプロバイダーは後からエージェント単位で設定できます。</>
                    )}
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id)).map((p) => {
                    const sel = godProvider === p.id;
                    return (
                      <label key={p.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 10px',
                        background: sel ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
                        boxShadow: `inset 0 0 0 ${sel ? 2 : 1}px ${sel ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`,
                        cursor: 'pointer'
                      }}>
                        <input
                          type="radio"
                          name="godProvider"
                          value={p.id}
                          checked={sel}
                          onChange={() => {
                            setGodProvider(p.id);
                            // Reset the model to the new provider's recommended pick so the
                            // dropdown below always shows a valid model for the chosen engine.
                            setGodModel(p.recommendedOrchestratorModel);
                          }}
                          style={{ width: 16, height: 16, flexShrink: 0 }}
                        />
                        <span style={{
                          width: 22, height: 22, flexShrink: 0, display: 'flex',
                          alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-900)'
                        }}>
                          <ProviderLogo provider={p.id} size={18} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 11 }}>
                            {p.label.toUpperCase()}
                          </span>
                          {PROVIDER_BLURB[p.id] && (
                            <span style={{ display: 'block', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                              {PROVIDER_BLURB[p.id]}
                            </span>
                          )}
                        </span>
                        {(() => {
                          const a = classifyEngineAvailability(engines, p.id);
                          const badge = engineAvailabilityBadge(a);
                          if (!badge) return null;
                          const bad = a.state === 'not-installable';
                          return (
                            <span title={a.path ?? undefined} style={{
                              fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                              background: a.state === 'installed' ? 'var(--cth-mint-light)' : bad ? 'var(--cth-paper-100)' : 'var(--cth-cream-200)',
                              color: bad ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                              fontFamily: 'var(--cth-font-display)', flexShrink: 0
                            }}>{badge}</span>
                          );
                        })()}
                        {p.id === 'claude' && (
                          <span style={{
                            fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                            background: 'var(--cth-lemon)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            fontFamily: 'var(--cth-font-display)', flexShrink: 0
                          }}>おすすめ</span>
                        )}
                      </label>
                    );
                  })}
                </div>
                {engineBlocked && (
                  <div style={{
                    display: 'flex', flexDirection: 'column', gap: 8, padding: 10,
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                    fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)'
                  }}>
                    <span>{engineAvailabilityMessage(selectedEngine, providerPreset(godProvider).label)}</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <PixelButton variant="secondary" size="sm" onClick={() => { void probeEngines(); }} disabled={probing}>
                        {probing ? '確認中...' : '再チェック'}
                      </PixelButton>
                      {selectedEngine.docsUrl && (
                        <PixelButton variant="ghost" size="sm" onClick={() => { void window.cth.openExternal(selectedEngine.docsUrl!); }}>
                          インストール手順
                        </PixelButton>
                      )}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>モデル</div>
                  <select
                    value={godModel ?? ''}
                    onChange={(e) => setGodModel(e.target.value || undefined)}
                    style={inputStyle}
                  >
                    {modelsForProvider(godProvider).map((m) => (
                      <option key={m.label} value={m.id ?? ''}>{m.label}</option>
                    ))}
                  </select>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                    ここではMichaelのエンジンだけを設定します。他のプロバイダーは後からエージェントごとに実行できます。
                  </div>
                </div>
              </>
            )}

            {step === 'repos' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {plain ? (
                    <>
                    <strong>プロジェクト</strong>を追加してください。プロジェクトは単なるフォルダです —
                    コード、ドキュメント、メモ、エージェントに扱ってほしいファイルなど何でも入れられます。
                    新しいフォルダを作っても既存のものを選んでもよく、いつでも追加できます。</>
                  ) : (
                    <>エージェントに作業させてきたいリポジトリを追加してください。各フォルダが
                    <strong> プロジェクト</strong>(フロアの1部屋)になり、複数のエージェントで共有できます。
                    後からいくらでも追加できます。</>
                  )}
                </p>
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 6,
                  maxHeight: 200, overflowY: 'auto'
                }}>
                  {repos.length === 0 && (
                    <div style={{
                      padding: 12,
                      fontSize: 13,
                      color: 'var(--cth-ink-500)',
                      background: 'var(--cth-paper-200)',
                      textAlign: 'center'
                    }}>
                      {plain
                        ? 'まだプロジェクトはありません。省略可能 — 後から追加できます。'
                        : 'まだリポジトリはありません。省略可能ですが、追加をおすすめします。'}
                    </div>
                  )}
                  {repos.map((r) => (
                    <div key={r} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px',
                      background: 'var(--cth-paper-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                    }}>
                      <Icon name="folder" />
                      <span style={{
                        flex: 1,
                        fontFamily: 'var(--cth-font-mono)', fontSize: 13,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                      }}>{r}</span>
                      <PixelButton variant="ghost" size="sm" onClick={() => removeRepo(r)}>
                        <Icon name="x" />
                      </PixelButton>
                    </div>
                  ))}
                </div>
                <PixelButton variant="secondary" size="md" onClick={pickRepo}>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Icon name="plus" /> {plain ? 'プロジェクトを追加' : 'リポジトリを追加'}
                  </span>
                </PixelButton>
              </>
            )}

            {step === 'permissions' && (
              <>
                {/* AUTONOMY — merged from the old "auto mode" step (item 5). One choice
                    that maps to each engine's flag (item 6): autoMode → claude
                    bypassPermissions / codex --dangerously-bypass-approvals-and-sandbox,
                    etc.; off → each engine's ask-first default. */}
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  エージェントにどこまで自律的に任せますか？
                </div>
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: 12,
                  background: autoMode ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
                  boxShadow: `inset 0 0 0 2px ${autoMode ? 'var(--cth-mint)' : 'var(--cth-ink-500)'}`,
                  cursor: 'pointer'
                }}>
                  <input
                    type="checkbox"
                    checked={autoMode}
                    onChange={(e) => setAutoMode(e.target.checked)}
                    style={{ width: 18, height: 18, flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px' }}>
                      {plain ? 'エージェントに自主的に作業させる' : '自律的に作業(AUTO MODE)'}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>
                      {plain
                        ? (autoMode
                            ? 'オン。エージェントは確認せずにタスクを進めるので、最もスムーズです。'
                            : 'オフ。エージェントはファイル変更やコマンド実行の前に、あなたに確認します。')
                        : (autoMode
                            ? 'オン。エージェントは止まりません — ClaudeはbypassPermissions、Codexは承認+サンドボックスをバイパス、など。'
                            : 'オフ。各エージェントは編集・シェルコマンドの前に確認します(Claudeのデフォルト、codex -a untrusted など)。')}
                    </div>
                  </div>
                </label>
                <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                  {plain
                    ? 'エージェントが自分のプロジェクト内で作業する場合に最適です。後から、エージェント単位でも変更できます。'
                    : '「コントロールルーム」体験にはこれが正しいデフォルトです。本番リポジトリでは危険なので、Add Agentダイアログでエージェント単位で上書きしてください。'}
                </div>

                <div style={{ height: 1, background: 'var(--cth-ink-300)', margin: '2px 0' }} />

                {/* RELIABILITY — keeping work firing while you're away. */}
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  あなたの不在中も作業を回し続ける
                </div>
                <p style={{ margin: 0, lineHeight: '20px', fontSize: 12, color: 'var(--cth-ink-700)' }}>
                  {plain
                    ? '離席していても、エージェントはスケジュールやライブターミナルで作業を続けます。これらの設定で状況を把握し、動き続けさせられます。'
                    : 'エージェントはスケジュールとライブターミナルで作業を続けます。Macが完全にスリープするとタイマーは一時停止しますが、復帰時すぐに追いつきます — 失われるものはなく、遅れるだけです。'}
                </p>

                <ToggleRow
                  icon="clock"
                  label="離席中も作業を続ける"
                  desc="強力なキープアライブ: エージェントの稼働中はMacのスリープを防ぎ、離席中でもスケジュールやターミナルが時間通りに動きます。バッテリーを多く消費するため電源接続時におすすめ。デフォルトはオフ。"
                  on={strongKeepalive}
                  tint="var(--cth-mint-light)"
                  edge="var(--cth-mint)"
                  onChange={toggleStrongKeepalive}
                />

                <ToggleRow
                  icon="bell"
                  label="デスクトップ通知"
                  desc="エージェントがあなたを必要としたり、ターミナルの復旧が必要になったりしたときに通知します — 離席中でも届きます。macOSでは初回に許可を求められます。"
                  on={notifications}
                  tint="var(--cth-peach-light)"
                  edge="var(--cth-peach)"
                  onChange={toggleNotifications}
                />

                <ToggleRow
                  icon="play"
                  label="ログイン時に起動"
                  desc="再起動後にハーネスを自動で再起動し、予定されたミッションを自分で再開できるようにします。確認なし — 即座に適用されます。"
                  on={openAtLogin}
                  tint="var(--cth-sky-light)"
                  edge="var(--cth-sky)"
                  onChange={toggleOpenAtLogin}
                />

                <ToggleRow
                  icon="info"
                  label="匿名の使用統計を共有"
                  desc="Munder Difflin改善のための匿名イベント(アプリ起動、エージェント起動、機能利用など)のみ。プロンプト、コード、ファイルパス、エージェントの出力は決して送信しません。一覧はTELEMETRY.md、設定はいつでも変更できます。"
                  on={shareStats}
                  tint="var(--cth-lemon-light)"
                  edge="var(--cth-lemon)"
                  onChange={() => setShareStats(!shareStats)}
                />

                {/* LEVER 4 — instruction-only: macOS won't let the app flip Energy, so we deep-link the pane. */}
                <div style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>
                  <span style={{
                    width: 28, height: 28, flexShrink: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                  }}>
                    <Icon name="gear" />
                  </span>
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', marginBottom: 3 }}>
                        電源接続中はスリープさせない(手動)
                      </div>
                      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                        この項目だけはmacOSの仕様上、自分で設定する必要があります。バッテリー → オプションで、
                        (電源アダプター使用時に)「ディスプレイがオフのときに自動的にスリープしない」をオンにすると、
                        ディスプレイがスリープ中でもタイマーが動き続けます。
                        スリープ防止の設定がないとMacは本当にスリープします — 作業は失われず、復帰時に再開します。
                      </div>
                    </div>
                    <PixelButton variant="secondary" size="sm"
                      onClick={() => openSettings('x-apple.systempreferences:com.apple.preference.battery')}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="arrow-right" /> バッテリー設定を開く
                      </span>
                    </PixelButton>
                  </div>
                </div>
              </>
            )}

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 13,
                color: 'var(--cth-ink-900)',
                overflowWrap: 'anywhere'
              }}>{error}</div>
            )}

            {/* Footer / nav */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <Dots step={step} />
              <div style={{ display: 'flex', gap: 8 }}>
                {step !== 'persona' && step !== 'welcome' && (
                  <PixelButton variant="ghost" size="md" onClick={() => setStep(prevStep(step))} disabled={busy}>
                    戻る
                  </PixelButton>
                )}
                {step === 'welcome' && (
                  <PixelButton variant="ghost" size="md" onClick={() => setStep('persona')} disabled={busy}>
                    戻る
                  </PixelButton>
                )}
                {step !== 'permissions' && (
                  <PixelButton
                    variant="primary"
                    size="md"
                    onClick={() => {
                      // Validate the home step HERE. Without this the only check
                      // lives in finish(), so an empty field walks you through all
                      // four steps and then bounces you back to step 1 to be told.
                      if (step === 'home' && !home.trim()) {
                        setError('先にハーネスホームのフォルダを選択してください。');
                        return;
                      }
                      // Same idea for the engine: refuse here, with the reason on
                      // screen, instead of letting a pick that cannot boot through
                      // to a Michael that never starts.
                      if (step === 'orchestrator' && engineBlocked) {
                        setError(`${providerPreset(godProvider).label}がインストールされていません。インストールして「再チェック」を押すか、別のエンジンを選んでください。`);
                        return;
                      }
                      setError(undefined);
                      setStep(nextStep(step));
                    }}
                    disabled={(step === 'persona' && !audience) || (step === 'orchestrator' && engineBlocked)}
                  >
                    {step === 'welcome' ? 'セットアップ開始' : '次へ'}
                  </PixelButton>
                )}
                {step === 'permissions' && (
                  <PixelButton variant="primary" size="md" onClick={finish} disabled={busy}>
                    {busy ? '保存中...' : '完了'}
                  </PixelButton>
                )}
              </div>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function PersonaCard({ icon, title, desc, selected, onClick }: {
  icon: IconName;
  title: string;
  desc: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', border: 'none',
        padding: 12, display: 'flex', flexDirection: 'column', gap: 6,
        background: selected ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
        boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${selected ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`
      }}
    >
      <span style={{
        width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        <Icon name={icon} />
      </span>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-900)' }}>
        {title}
      </span>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
        {desc}
      </span>
    </button>
  );
}

function ToggleRow({ icon, label, desc, on, tint, edge, onChange }: {
  icon: IconName;
  label: string;
  desc: string;
  on: boolean;
  tint: string; // background token when on
  edge: string; // border token when on
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
      background: on ? tint : 'var(--cth-paper-100)',
      boxShadow: `inset 0 0 0 ${on ? 2 : 1}px ${on ? edge : 'var(--cth-ink-300)'}`,
      cursor: 'pointer'
    }}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, flexShrink: 0, marginTop: 5 }}
      />
      <span style={{
        width: 28, height: 28, flexShrink: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        <Icon name={icon} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', marginBottom: 3 }}>
          {label}
        </span>
        <span style={{ display: 'block', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
          {desc}
        </span>
      </span>
    </label>
  );
}

function Dots({ step }: { step: Step }) {
  const order: Step[] = ['persona', 'welcome', 'home', 'orchestrator', 'repos', 'permissions'];
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {order.map((s) => (
        <span key={s} style={{
          width: 8, height: 8,
          background: s === step ? 'var(--cth-ink-900)' : 'var(--cth-cream-300)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }} />
      ))}
    </div>
  );
}

function nextStep(s: Step): Step {
  return s === 'persona' ? 'welcome'
    : s === 'welcome' ? 'home'
    : s === 'home' ? 'orchestrator'
    : s === 'orchestrator' ? 'repos'
    : s === 'repos' ? 'permissions'
    : 'done';
}
function prevStep(s: Step): Step {
  return s === 'permissions' ? 'repos'
    : s === 'repos' ? 'orchestrator'
    : s === 'orchestrator' ? 'home'
    : s === 'home' ? 'welcome'
    : s === 'welcome' ? 'persona'
    : 'persona';
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};
