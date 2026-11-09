'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { evaluateNumericExpression } from './numeric-expression';

type NumericInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'type' | 'onChange' | 'onBlur' | 'onKeyDown'> & {
  value: number;
  onValueChange: (value: number) => void;
  suffix?: string;
  strictRange?: boolean;
  formatValue?: (value: number) => string;
};

const invalidMessage = 'Enter a valid number or arithmetic expression. Division by zero is not allowed.';

export function validateNumericInputs(scope: HTMLElement | null): boolean {
  const inputs = scope?.querySelectorAll<HTMLInputElement>('input[data-numeric-input]:not(:disabled)');
  for (const input of inputs ?? []) {
    if (!input.checkValidity()) {
      input.focus();
      input.reportValidity();
      return false;
    }
  }
  return true;
}

export default function NumericInput({ value, onValueChange, suffix = '', min, max, step = 1, strictRange = false, formatValue, ...props }: NumericInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const displayValue = `${formatValue ? formatValue(value) : value}${suffix}`;
  const parse = (text: string) => evaluateNumericExpression(suffix && text.trimEnd().endsWith(suffix) ? text.trimEnd().slice(0, -suffix.length) : text);
  const normalize = (next: number) => Math.max(min === undefined ? -Infinity : Number(min), Math.min(max === undefined ? Infinity : Number(max), next));
  const update = (text: string, input: HTMLInputElement, commit: boolean) => {
    const result = parse(text);
    const message = result === null ? invalidMessage : strictRange && result !== normalize(result) ? 'Enter a value within the supported resolution range.' : '';
    input.setCustomValidity(message);
    setError(message);
    setDraft(!message && commit ? null : text);
    if (result !== null && !message) onValueChange(normalize(result));
    return !message;
  };
  const commitDraft = (input: HTMLInputElement) => {
    // A formatted value may be rounded for display only.
    if (input.value === displayValue) {
      input.setCustomValidity('');
      setError('');
      setDraft(null);
      return true;
    }
    return update(input.value, input, true);
  };

  return <input {...props} type="text" data-numeric-input="" value={draft ?? displayValue} aria-invalid={Boolean(error) || undefined}
    title={error || (props.title ?? 'Supports +, -, *, /, and parentheses. Press Enter or leave the field to show the result.')}
    spellCheck={false} autoComplete="off" maxLength={256}
    onChange={(event) => update(event.target.value, event.currentTarget, false)}
    onBlur={(event) => { commitDraft(event.currentTarget); }}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
        if (commitDraft(event.currentTarget)) event.currentTarget.blur();
        else event.currentTarget.reportValidity();
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.setCustomValidity(''); setError(''); setDraft(null);
        event.currentTarget.value = displayValue; event.currentTarget.blur();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const increment = step === 'any' ? 1 : Number(step);
        const current = draft === null ? value : (parse(event.currentTarget.value) ?? value);
        const next = normalize(current + (event.key === 'ArrowUp' ? increment : -increment));
        update(String(normalize(Number(next.toPrecision(12)))), event.currentTarget, true);
      }
    }} />;
}
