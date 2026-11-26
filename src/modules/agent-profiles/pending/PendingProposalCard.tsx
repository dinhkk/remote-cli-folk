import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { sensitiveReasonKey } from '@/modules/agent-profiles/bundle/bundle-helpers';
import { Badge, Button } from '@/shared/ui';
import type { ChangesetAction, ChangesetFieldChange, ChangesetReviewItem, PendingConfirmRequest, PendingProposalView } from '@/shared/types';

type PendingProposalCardProps = {
  proposal: PendingProposalView;
  /** The time (ms since the epoch) age and expiry are measured against: when the list was read. */
  now: number;
  /** True while a confirm or reject request is running: every button waits. */
  busy: boolean;
  onConfirm: (request: PendingConfirmRequest) => void;
  onReject: () => void;
};

const ACTION_VARIANT: Record<ChangesetAction, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  create: 'default',
  overwrite: 'outline',
  delete: 'destructive',
  identical: 'secondary',
  refused: 'destructive',
};

/** Longest text shown without "Show full text". */
const COLLAPSED_CHARS = 160;
const COLLAPSED_LINES = 3;

const isLong = (text: string | null): boolean => text !== null && (text.length > COLLAPSED_CHARS || text.split('\n').length > COLLAPSED_LINES);

/** The first part of a long text, cut at the character or line limit. */
const cut = (text: string): string => {
  const lines = text.split('\n').slice(0, COLLAPSED_LINES).join('\n');
  return `${lines.slice(0, COLLAPSED_CHARS)}...`;
};

/** Minutes rounded, written as hours and minutes through the translations ("1 h 5 min", "12 min"). */
function describeSpan(t: TFunction, milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours > 0 ? t('pending.time.hours', { count: hours }) : '', hours === 0 || rest > 0 ? t('pending.time.minutes', { count: rest }) : '']
    .filter(Boolean)
    .join(' ');
}

function FieldValue({ label, text, expanded }: { label: string; text: string | null; expanded: boolean }) {
  const { t } = useTranslation('agentProfiles');
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      {text === null
        ? <p className="text-xs italic text-muted-foreground">{t('pending.absent')}</p>
        : <pre className="whitespace-pre-wrap break-words rounded bg-muted/40 p-1 text-xs">{expanded || !isLong(text) ? text : cut(text)}</pre>}
    </div>
  );
}

function FieldChange({ change }: { change: ChangesetFieldChange }) {
  const { t } = useTranslation('agentProfiles');
  // Whether the long texts of this field are shown in full; local because only this row cares.
  const [expanded, setExpanded] = useState(false);
  const long = isLong(change.before) || isLong(change.after);
  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium">{change.field}</span>
        {long && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t('pending.showLess', { field: change.field }) : t('pending.showFull', { field: change.field })}
            onClick={() => setExpanded((current) => !current)}
            className="text-xs text-primary underline"
          >
            {expanded ? t('pending.showLessShort') : t('pending.showFullShort')}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <FieldValue label={t('pending.before')} text={change.before} expanded={expanded} />
        <FieldValue label={t('pending.after')} text={change.after} expanded={expanded} />
      </div>
    </li>
  );
}

type TickProps = { label: string; checked: boolean; disabled: boolean; onChange: () => void };

function Tick({ label, checked, disabled, onChange }: TickProps) {
  return <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} className="h-4 w-4" />;
}

/** Adds the key to the set or takes it out. */
const toggled = (set: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

/**
 * One waiting proposal: who proposed it, how old it is and when it expires, then the readable review of each item the server
 * built (create, overwrite or delete, the lines saying what happens or is lost, before and after of changed fields with
 * "Show full text" for long ones, the sensitive badge with its reasons). Nothing is ticked by default: each overwrite, delete
 * and sensitive item needs its own tick ("Select all sensitive" ticks the sensitive ones). Confirm sends the ticks with the
 * `basis` exactly as listed, so an item that moved since is refused; Reject drops the proposal. Used by the Pending tab.
 */
export function PendingProposalCard({ proposal, now, busy, onConfirm, onReject }: PendingProposalCardProps) {
  const { t } = useTranslation('agentProfiles');
  // Keys ticked for overwrite or delete, and keys of sensitive items the user accepted.
  const [overwrite, setOverwrite] = useState<ReadonlySet<string>>(new Set());
  const [acceptSensitive, setAcceptSensitive] = useState<ReadonlySet<string>>(new Set());

  const age = now - Date.parse(proposal.createdAt);
  const left = Date.parse(proposal.expiresAt) - now;
  // A refused item can never be applied, so it gets no tick.
  const tickable = proposal.items.filter((item) => item.action !== 'refused');
  const sensitiveKeys = tickable.filter((item) => item.sensitive.length > 0).map((item) => item.key);

  const confirm = () => {
    const keys = new Set(tickable.map((item) => item.key));
    const sentOverwrite = tickable.filter((item) => item.needsTick && overwrite.has(item.key)).map((item) => item.key);
    const sentSensitive = sensitiveKeys.filter((key) => acceptSensitive.has(key) && keys.has(key));
    const basis = Object.fromEntries([...sentOverwrite, ...sentSensitive].map((key) => [key, proposal.basis[key] ?? 'absent']));
    onConfirm({ overwrite: sentOverwrite, acceptSensitive: sentSensitive, basis });
  };

  const renderItem = (item: ChangesetReviewItem) => {
    const ticks = item.action !== 'refused';
    return (
      <li key={item.key} className="space-y-1 rounded-md border border-border p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={ACTION_VARIANT[item.action]}>{t(`pending.action.${item.action}`)}</Badge>
          <span className="font-medium">{item.label}</span>
          <Badge variant="outline">{t(`bundle.import.kind.${item.kind}`)}</Badge>
        </div>
        {item.refusal && <p className="text-sm text-destructive">{item.refusal.message}</p>}
        {item.lines.length > 0 && <ul className="space-y-0.5 text-sm">{item.lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>}
        {item.changes.length > 0 && <ul className="space-y-2">{item.changes.map((change) => <FieldChange key={change.field} change={change} />)}</ul>}
        {ticks && item.sensitive.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="destructive">{t('bundle.import.sensitiveBadge')}</Badge>
            <span className="text-xs">{item.sensitive.map((reason) => {
              const { key, values } = sensitiveReasonKey(reason);
              return t(key, { ...values, defaultValue: reason });
            }).join(', ')}</span>
            <Tick
              label={t('bundle.import.sensitiveAllow', { name: item.label })}
              checked={acceptSensitive.has(item.key)}
              disabled={busy}
              onChange={() => setAcceptSensitive((current) => toggled(current, item.key))}
            />
          </div>
        )}
        {ticks && item.needsTick && (
          <label className="flex items-center gap-2 text-sm">
            <Tick
              label={item.action === 'delete' ? t('pending.deleteTick', { name: item.label }) : t('bundle.import.overwrite', { name: item.label })}
              checked={overwrite.has(item.key)}
              disabled={busy}
              onChange={() => setOverwrite((current) => toggled(current, item.key))}
            />
            <span aria-hidden="true">{item.action === 'delete' ? t('pending.deleteShort') : t('bundle.import.overwriteShort')}</span>
          </label>
        )}
      </li>
    );
  };

  return (
    <article aria-label={t('pending.proposalLabel', { agent: proposal.agentName })} className="space-y-3 rounded-md border border-border p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{proposal.agentName}</h3>
        <span className="text-xs text-muted-foreground">{age < 60_000 ? t('pending.justNow') : t('pending.age', { time: describeSpan(t, age) })}</span>
        <span className="text-xs text-muted-foreground">{left > 0 ? t('pending.expires', { time: describeSpan(t, left) }) : t('pending.expired')}</span>
      </header>
      {sensitiveKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm">
          <p className="min-w-0 flex-1 text-muted-foreground">{t('bundle.import.sensitiveHint')}</p>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setAcceptSensitive(new Set(sensitiveKeys))}>{t('bundle.import.selectAllSensitive')}</Button>
        </div>
      )}
      <ul className="space-y-2">{proposal.items.map(renderItem)}</ul>
      <p className="text-xs text-muted-foreground">{t('pending.untickedHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} aria-label={t('pending.confirmFor', { agent: proposal.agentName })} onClick={confirm}>{t('pending.confirm')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={t('pending.rejectFor', { agent: proposal.agentName })} onClick={onReject}>{t('pending.reject')}</Button>
      </div>
    </article>
  );
}
