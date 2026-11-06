import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useRemoteApi } from '@/modules/remote/hooks/useRemoteApi';
import { formatRemoteTime } from '@/modules/remote/utils/format-remote-time';
import { peerDisplayName } from '@/modules/remote/utils/peer-display-name';
import { PEER_STATE_DOT_CLASS } from '@/modules/remote/utils/peer-state-dot-class';
import { purgeRemoteTabStorage } from '@/shared/transport/controller-tab-storage';
import { Button, Input } from '@/shared/ui';
import type { RemotePeer, RemotePeerState } from '@/shared/types';

// States in which the pairing cannot serve a tab; the row says what to do about it.
const DEAD_STATES: ReadonlySet<RemotePeerState> = new Set(['revoked', 'replaced', 'locked', 'expired']);

// Same limit the server enforces on an alias (it refuses a longer one).
const MAX_ALIAS_LENGTH = 40;

type PeerListProps = {
  peers: RemotePeer[];
  /** Brings the Host's tab to the front. */
  onOpen: (peerId: string) => void;
  /** Called after a pairing was forgotten, so the screen re-reads the list. */
  onChanged: () => void;
  /** Sits next to the heading, for the "Pair with a Host" button. */
  headerAction?: ReactNode;
};

/**
 * The Hosts this browser controls (FR-6, FR-9): each row shows the link state, opens
 * the Host's tab and can forget the pairing. Forgetting is the Controller's own
 * `DELETE /peers/:peerId`, which the contract does not mark as needing the
 * password, so it takes a plain two-step confirmation. Rendered by RemoteSettingsTab.
 */
export function PeerList({ peers, onOpen, onChanged, headerAction }: PeerListProps) {
  const { t } = useTranslation('remote');
  const remote = useRemoteApi();
  // The pairing whose "Forget" is waiting for the second, confirming press.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Blocks a second request while forgetting is in flight.
  const [isForgetting, setIsForgetting] = useState(false);
  // The pairing whose last forget attempt failed, to say so on its row.
  const [failedId, setFailedId] = useState<string | null>(null);
  // The pairing being renamed, the text typed so far, and whether saving is in flight or failed.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [isSavingAlias, setIsSavingAlias] = useState(false);
  const [aliasFailedId, setAliasFailedId] = useState<string | null>(null);

  const startRename = (peer: RemotePeer) => {
    setConfirmingId(null);
    setAliasFailedId(null);
    setAliasDraft(peer.alias ?? '');
    setRenamingId(peer.peerId);
  };

  // Blank text clears the alias, so the Host is shown under the name it declared again.
  const saveAlias = async (event: FormEvent, peerId: string) => {
    event.preventDefault();
    setIsSavingAlias(true);
    setAliasFailedId(null);
    const trimmed = aliasDraft.trim();
    const result = await remote.setPeerAlias(peerId, trimmed === '' ? null : trimmed);
    setIsSavingAlias(false);
    if (result.ok) {
      setRenamingId(null);
      onChanged();
    } else {
      setAliasFailedId(peerId);
    }
  };

  const forget = async (peerId: string) => {
    setIsForgetting(true);
    setFailedId(null);
    const result = await remote.forgetPeer(peerId);
    setIsForgetting(false);
    setConfirmingId(null);
    if (result.ok) {
      // What the tab kept (drafts, last project, ...) came from the Host and goes with the pairing.
      purgeRemoteTabStorage(peerId);
      onChanged();
    } else {
      setFailedId(peerId);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">{t('peers.title')}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t('peers.description')}</p>
        </div>
        {headerAction}
      </div>

      {peers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('peers.empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {peers.map((peer) => {
            const lastConnected = formatRemoteTime(peer.lastConnectedAt);
            return (
              <li key={peer.peerId} data-state={peer.state} className="space-y-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 max-w-full truncate text-sm font-medium text-foreground">{peerDisplayName(peer)}</span>
                  {peer.alias && (
                    <span
                      className="min-w-0 max-w-full truncate text-xs text-muted-foreground"
                      title={t('peers.declaredName')}
                      data-testid="declared-name"
                    >
                      {peer.name}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${PEER_STATE_DOT_CLASS[peer.state]}`} />
                    <span>{t(`peers.state.${peer.state}`)}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {lastConnected ? t('peers.lastConnected', { time: lastConnected }) : t('peers.neverConnected')}
                  </span>
                </div>
                {DEAD_STATES.has(peer.state) && (
                  <p className="text-xs text-muted-foreground">{t(`tabs.state.${peer.state}`)}</p>
                )}

                {confirmingId === peer.peerId ? (
                  <div className="space-y-2">
                    <p className="text-sm text-foreground">{t('peers.forgetConfirm', { name: peerDisplayName(peer) })}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="destructive" disabled={isForgetting} onClick={() => void forget(peer.peerId)}>
                        {t('peers.forgetConfirmButton')}
                      </Button>
                      <Button size="sm" variant="outline" disabled={isForgetting} onClick={() => setConfirmingId(null)}>
                        {t('peers.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : renamingId === peer.peerId ? (
                  <form className="space-y-2" onSubmit={(event) => void saveAlias(event, peer.peerId)}>
                    <label className="block text-sm text-foreground" htmlFor={`alias-${peer.peerId}`}>
                      {t('peers.renameLabel')}
                    </label>
                    <Input
                      id={`alias-${peer.peerId}`}
                      value={aliasDraft}
                      maxLength={MAX_ALIAS_LENGTH}
                      placeholder={peer.name}
                      autoFocus
                      disabled={isSavingAlias}
                      onChange={(event) => setAliasDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t('peers.renameHint')}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" type="submit" disabled={isSavingAlias}>
                        {t('peers.renameSave')}
                      </Button>
                      <Button size="sm" type="button" variant="outline" disabled={isSavingAlias} onClick={() => setRenamingId(null)}>
                        {t('peers.cancel')}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => onOpen(peer.peerId)}>
                      {t('peers.open')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => startRename(peer)}>
                      {t('peers.rename')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setFailedId(null);
                        setConfirmingId(peer.peerId);
                      }}
                    >
                      {t('peers.forget')}
                    </Button>
                  </div>
                )}
                {aliasFailedId === peer.peerId && (
                  <p role="alert" className="text-sm text-destructive">
                    {t('peers.renameFailed')}
                  </p>
                )}
                {failedId === peer.peerId && (
                  <p role="alert" className="text-sm text-destructive">
                    {t('peers.forgetFailed')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
