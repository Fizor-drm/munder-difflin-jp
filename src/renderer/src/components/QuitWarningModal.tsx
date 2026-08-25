import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';

/** Renderer-side closing-time view state. Mirrors the main process's
 *  ClosingTimeEvent phases, plus a local 'error' for a failed start. */
export interface ClosingTimeState {
  phase: 'started' | 'progress' | 'complete' | 'timeout' | 'error';
  acked: number;
  total: number;
  error?: string;
}

export interface QuitWarningModalProps {
  ptyCount: number;
  /** Non-null while the closing-time protocol runs — switches the dialog into
   *  the "wrapping up the floor" progress view. */
  closing?: ClosingTimeState | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** Start the graceful shutdown (the third button). */
  onClosingTime?: () => void;
}

export function QuitWarningModal({ ptyCount, closing, onCancel, onConfirm, onClosingTime }: QuitWarningModalProps) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    await onConfirm();
    // No need to clear busy — the app is quitting.
  };

  const inClosingTime = !!closing && closing.phase !== 'error';

  return (
    <div
      onClick={inClosingTime ? undefined : onCancel}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Above EVERY modal, not just most of them. Modals in this app sit at
        // 500 (add agent, edit agent, the release drop) and overlays below that.
        // At 300 this dialog opened BEHIND the release drop, so clicking quit
        // with a drop on screen looked like quit did nothing — while a hidden
        // dialog held the app open. This is the last thing the user is asked
        // before the process dies; it outranks whatever it interrupts.
        zIndex: 1000
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, maxWidth: '92vw' }}
      >
        <PixelPanel variant="dialog" title={inClosingTime ? 'クロージングタイム' : '今すぐ終了しますか？'} noPadding>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {inClosingTime ? (
              <>
                {/* ── Graceful shutdown in progress ──────────────────────── */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 32, height: 32,
                    background: closing!.phase === 'complete' ? 'var(--cth-mint-light, #cdeccd)' : 'var(--cth-lemon-light, #f6ecc4)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0
                  }}>
                    <Icon name="bell" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 12, lineHeight: '20px',
                      color: 'var(--cth-ink-900)',
                      marginBottom: 4
                    }}>
                      {closing!.phase === 'complete'
                        ? 'フロア保存済み — また明日'
                        : closing!.phase === 'timeout'
                          ? 'まだ片付け中…'
                          : 'フロアを片付け中'}
                    </div>
                    <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                      {closing!.phase === 'complete' ? (
                        <>全エージェントがメモリを保存し、オーケストレーターがシャットダウンを確認しました。
                        まもなくハーネスが自ら終了します。</>
                      ) : (
                        <>オーケストレーターがクロージングタイムを通知しました。各ワーカーは作業を退避して
                        メモリを保存し、報告します — 何も失わないことをオーケストレーターが確認した後でのみ、
                        アプリは終了します。</>
                      )}
                    </div>
                  </div>
                </div>

                {/* ACK progress */}
                <div style={{
                  padding: 8,
                  background: 'var(--cth-cream-200)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontSize: 12, lineHeight: '18px',
                  color: 'var(--cth-ink-700)',
                  fontFamily: 'var(--cth-font-display)'
                }}>
                  {closing!.total > 0
                    ? `${closing!.acked} / ${closing!.total} ワーカーが確認済み${closing!.acked >= closing!.total ? ' — オーケストレーター待ち' : ''}`
                    : 'フロアにワーカーなし — オーケストレーター待ち'}
                  {closing!.phase === 'timeout' && (
                    <div style={{ marginTop: 6, fontFamily: 'var(--cth-font-body, inherit)' }}>
                      時間がかかっています(エージェントがコンパクション中、またはツール呼び出しの最中かもしれません)。
                      待ち続けるか、強制終了してデータ損失を受け入れてください。
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  {closing!.phase !== 'complete' && (
                    <>
                      <PixelButton variant="secondary" size="md" onClick={onCancel} disabled={busy}>
                        キャンセル — 作業に戻る
                      </PixelButton>
                      <PixelButton variant="destructive" size="md" onClick={confirm} disabled={busy}>
                        {busy ? '強制終了中...' : '今すぐ強制終了'}
                      </PixelButton>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* ── The classic quit warning ────────────────────────────── */}
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
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 12, lineHeight: '20px',
                      color: 'var(--cth-ink-900)',
                      marginBottom: 4
                    }}>
                      {ptyCount} 件のエージェントが実行中
                    </div>
                    <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                      ハーネスを閉じると{' '}
                      {ptyCount === 1 ? '実行中のclaudeセッション' : `実行中の${ptyCount}件のclaudeセッション`}{' '}
                      が終了し、メモリ上に保持していた未保存の進行状況は破棄されます。PTYが終了すると、
                      各セッション内の会話履歴は失われます。
                    </div>
                  </div>
                </div>

                <div style={{
                  padding: 8,
                  background: 'var(--cth-cream-200)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontSize: 12, lineHeight: '18px',
                  color: 'var(--cth-ink-700)'
                }}>
                  <strong>クロージングタイム</strong>が安全な終了方法です — オーケストレーターが各エージェントに
                  作業のコミットとメモリの保存を行わせ、フロア全体が確認した時点でアプリが自ら閉じます。
                  データ損失はありません。
                </div>

                {closing?.phase === 'error' && (
                  <div style={{
                    padding: 8,
                    background: 'var(--cth-coral-light)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontSize: 12, lineHeight: '18px',
                    color: 'var(--cth-ink-900)'
                  }}>
                    {closing.error ?? 'クロージングタイムを開始できませんでした。'}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                  <PixelButton variant="secondary" size="md" onClick={onCancel} disabled={busy}>
                    実行を続ける
                  </PixelButton>
                  {onClosingTime && (
                    <PixelButton variant="primary" size="md" onClick={onClosingTime} disabled={busy}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="clock" /> クロージングタイム
                      </span>
                    </PixelButton>
                  )}
                  <PixelButton variant="destructive" size="md" onClick={confirm} disabled={busy}>
                    {busy ? '強制終了中...' : `${ptyCount === 1 ? '強制終了して終了' : '全員強制終了して終了'}`}
                  </PixelButton>
                </div>
              </>
            )}
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
