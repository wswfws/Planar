import { useRef, useState, type ReactNode } from 'react';
import type { VariableType } from '../core/types';
import { useEditor } from './EditorContext';
import { Icon, type IconName } from './icons';

/** Evaluates simple arithmetic like "100+20" or "50*2"; null if invalid. */
export function evaluateExpression(input: string): number | null {
  const s = input.replace(/,/g, '.').replace(/\s+/g, '');
  if (!s || !/^[-+*/().\d]+$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  const number = (): number => {
    if (peek() === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') throw new Error('paren');
      i++;
      return v;
    }
    if (peek() === '-') {
      i++;
      return -number();
    }
    if (peek() === '+') {
      i++;
      return number();
    }
    const m = /^\d*\.?\d+|^\d+\./.exec(s.slice(i));
    if (!m) throw new Error('number');
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = (): number => {
    let v = number();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = number();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  try {
    const v = expr();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function format(v: number | null, precision: number): string {
  if (v === null) return '';
  const f = 10 ** precision;
  return String(Math.round(v * f) / f);
}

interface NumberFieldProps {
  label: ReactNode;
  value: number | null;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  suffix?: string;
  title?: string;
  disabled?: boolean;
  /** Optional variable binding for this field. */
  bind?: BindProps;
}

/** Numeric input with arithmetic support and a draggable (scrub) label. */
export function NumberField({ label, value, onChange, min = -Infinity, max = Infinity, step = 1, precision = 2, suffix, title, disabled, bind }: NumberFieldProps) {
  // Text being typed while the field is focused; otherwise the live value is shown.
  const [draft, setDraft] = useState<string | null>(null);
  const skipCommit = useRef(false);
  const scrub = useRef<{ x: number; start: number } | null>(null);
  const editor = useEditor();
  const boundName = bind?.boundId ? editor.doc.variables.find((v) => v.id === bind.boundId)?.name : undefined;

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const commit = () => {
    if (draft !== null && !skipCommit.current) {
      const v = evaluateExpression(draft);
      if (v !== null && v !== value) onChange(clamp(v));
    }
    skipCommit.current = false;
    setDraft(null);
  };

  return (
    <label className={`number-field${disabled ? ' disabled' : ''}${boundName ? ' bound' : ''}`} title={title}>
      <span
        className="number-label"
        onPointerDown={(e) => {
          if (value === null || disabled) return;
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          scrub.current = { x: e.clientX, start: value };
          editor.begin();
        }}
        onPointerMove={(e) => {
          if (!scrub.current) return;
          const delta = Math.round((e.clientX - scrub.current.x) / 2) * step * (e.shiftKey ? 10 : 1);
          onChange(clamp(scrub.current.start + delta));
        }}
        onPointerUp={() => {
          if (!scrub.current) return;
          scrub.current = null;
          editor.commit();
        }}
      >
        {label}
      </span>
      <input
        value={draft ?? boundName ?? format(value, precision)}
        disabled={disabled}
        readOnly={!!boundName}
        placeholder={value === null ? 'Mixed' : undefined}
        onFocus={(e) => {
          setDraft(format(value, precision));
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            skipCommit.current = true;
            (e.target as HTMLInputElement).blur();
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== null) {
            e.preventDefault();
            const v = clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
            onChange(v);
            setDraft(format(v, precision));
          }
        }}
      />
      {suffix && !boundName && <span className="number-suffix">{suffix}</span>}
      {bind && !disabled && <BindSelect {...bind} />}
    </label>
  );
}

export function normalizeHex(input: string): string | null {
  let h = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{1,2}$/i.test(h)) h = h.padStart(2, h).repeat(3).slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(h) ? `#${h.toUpperCase()}` : null;
}

export interface BindProps {
  type: VariableType;
  boundId?: string;
  onBind: (variableId: string | null) => void;
}

/** Compact picker that binds a property to a variable of the given type. */
export function BindSelect({ type, boundId, onBind }: BindProps) {
  const editor = useEditor();
  const options = editor.doc.variables.filter((v) => v.type === type);
  if (!options.length && !boundId) return null;
  return (
    <select
      className={`bind-select${boundId ? ' bound' : ''}`}
      title={boundId ? 'Bound to a variable' : 'Bind to a variable'}
      aria-label="Variable"
      value={boundId ?? ''}
      onChange={(e) => onBind(e.target.value === '__detach' ? null : e.target.value || null)}
      onClick={(e) => e.stopPropagation()}
    >
      <option value="">⬡</option>
      {options.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
      {boundId && <option value="__detach">Detach variable</option>}
    </select>
  );
}

export function ColorField({ value, onChange, bind }: { value: string; onChange: (hex: string) => void; bind?: BindProps }) {
  const editor = useEditor();
  const boundName = bind?.boundId ? editor.doc.variables.find((v) => v.id === bind.boundId)?.name : undefined;
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const hex = draft === null ? null : normalizeHex(draft);
    if (hex && hex !== value.toUpperCase()) onChange(hex);
    setDraft(null);
  };
  return (
    <span className={`color-field${boundName ? ' bound' : ''}`}>
      <input type="color" value={value} disabled={!!boundName} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <input
        className="hex"
        readOnly={!!boundName}
        value={draft ?? boundName ?? value.replace('#', '').toUpperCase()}
        onFocus={(e) => {
          setDraft(e.target.value);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {bind && <BindSelect {...bind} />}
    </span>
  );
}

export function IconButton({
  icon,
  title,
  onClick,
  active,
  disabled,
}: {
  icon: IconName;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={`icon-button${active ? ' active' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="panel-section">
      <header>
        <h3>{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  );
}
