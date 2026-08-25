import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ContextRule, ContextTriggerConfig } from '@shared/triggers';
import { getContextTrigger, setContextTrigger } from './api';
import {
  Callout, Field, Hint, IntervalPicker, Muted, PctField, SubCard, SubHeader, Toggle,
  fmtInterval, textareaStyle
} from './ui';

/**
 * CONTEXT — the trigger that fires on an agent's own terminal filling up rather
 * than on the clock alone. Two rules, and they are not the same operation:
 * compaction SUMMARISES the context, clearing THROWS IT AWAY.
 */

const WRITE_DEBOUNCE_MS = 400;

export function ContextSection({ onSummary }: { onSummary?: (s: string) => void }) {
  const [cfg, setCfg] = useState<ContextTriggerConfig | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    getContextTrigger().then((c) => { if (alive) setCfg(c); }).catch(() => { /* defaults */ });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!cfg) return;
    const on = [cfg.compact.enabled ? '圧縮' : null, cfg.clear.enabled ? 'クリア' : null].filter(Boolean);
    onSummary?.(on.length ? on.join(' + ') : '両方オフ');
  }, [cfg, onSummary]);

  // Optimistic + debounced: the controls answer instantly, and a burst of typing
  // in the message box collapses into one write instead of one per keystroke.
  const commit = (next: ContextTriggerConfig) => {
    setCfg(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setContextTrigger(next), WRITE_DEBOUNCE_MS);
  };
  const patch = (key: 'compact' | 'clear', fields: Partial<ContextRule>) => {
    if (!cfg) return;
    commit({ ...cfg, [key]: { ...cfg[key], ...fields } });
  };

  if (!cfg) return <Muted>読み込み中…</Muted>;

  return (
    <>
      <Muted>
        ルールが発火するのは、両方の条件が揃ったときだけです。前回の実行からの間隔が経過しており、かつそのエージェントのコンテキストがバーの値以上に埋まっていること。バーが0%なら時間だけで発火します。
      </Muted>
      <div style={{ height: 8 }} />

      <RuleCard
        title="圧縮"
        blurb="コンテキストを要約してスレッドを続けられるようにします。"
        rule={cfg.compact}
        messageLabel="追加指示"
        messageHint="プロバイダーの圧縮コマンドに追記されます。空ならコマンドのみ送信します。"
        messagePlaceholder="要約に必ず残す内容…"
        onPatch={(fields) => patch('compact', fields)}
      />

      <RuleCard
        title="クリア"
        blurb="コンテキストを破棄します。要約は行われません。"
        rule={cfg.clear}
        messageLabel="コマンド"
        messageHint="入力した内容がそのまま送信されます。空なら素のコマンドを送ります。"
        messagePlaceholder="/clear"
        caution={
          <>
            クリアはコンテキストを完全に破棄します。圧縮の縮小版ではありません。タスク実行中のエージェントは何をしていたか忘れます。別の方法でコンテキストを保持していない限り、オフのままにしてください。
          </>
        }
        onPatch={(fields) => patch('clear', fields)}
      />
    </>
  );
}

function RuleCard({ title, blurb, rule, messageLabel, messageHint, messagePlaceholder, caution, onPatch }: {
  title: string;
  blurb: string;
  rule: ContextRule;
  messageLabel: string;
  messageHint: string;
  messagePlaceholder: string;
  caution?: ReactNode;
  onPatch: (fields: Partial<ContextRule>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SubCard>
      <SubHeader
        open={open}
        onToggle={() => setOpen((o) => !o)}
        title={title}
        sub={blurb}
        right={<Toggle on={rule.enabled} onClick={() => onPatch({ enabled: !rule.enabled })} />}
      />
      {/* The caution is always on screen — it is why this ships off — but it only
          goes coral once the destructive rule is actually armed. A red box over a
          switched-off setting is crying wolf. */}
      {caution && <Callout tone={rule.enabled ? 'warn' : 'note'}>{caution}</Callout>}
      {!open && (
        <Hint>
          {rule.enabled
            ? <>{fmtInterval(rule.everyMs)}ごと、コンテキストが{rule.minContextPct}%を超えると実行されます。</>
            : <>オフ。</>}
        </Hint>
      )}
      {open && (
        <div style={{ marginTop: 4 }}>
          <Field label="実行間隔（最短）">
            {/* Main clamps a context cadence to 1 minute … 24 hours, so the
                picker offers exactly that range and never labels a value it
                cannot actually store. */}
            <IntervalPicker
              value={rule.everyMs}
              onChange={(everyMs) => onPatch({ everyMs })}
              minMs={60_000}
              maxMs={86_400_000}
            />
          </Field>
          <Field label="コンテキストバー">
            <PctField value={rule.minContextPct} onChange={(minContextPct) => onPatch({ minContextPct })} />
            <Hint>このルールが実行されるために必要な、ウィンドウの最低充填率。0%なら時間だけで発火します。</Hint>
          </Field>
          <Field label="大きいウィンドウでのバー">
            <PctField
              value={rule.minContextPctLargeWindow}
              onChange={(minContextPctLargeWindow) => onPatch({ minContextPctLargeWindow })}
            />
            <Hint>約100万トークンのウィンドウで使用されます。小さな割合でも膨大なテキスト量に相当します。</Hint>
          </Field>
          <Field label={messageLabel}>
            <textarea
              value={rule.message}
              onChange={(e) => onPatch({ message: e.target.value })}
              rows={3}
              placeholder={messagePlaceholder}
              style={textareaStyle}
            />
            <Hint>{messageHint}</Hint>
          </Field>
        </div>
      )}
    </SubCard>
  );
}
