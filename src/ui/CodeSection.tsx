import { useMemo, useState } from 'react';
import { generateCode, generateTokens, type CodeFormat } from '../codegen/codegen';
import type { Editor } from '../core/editor';
import { Section } from './controls';

/** Developer view: generated code for the selected layer. */
export function CodeSection({ editor, id }: { editor: Editor; id: string }) {
  const [format, setFormat] = useState<CodeFormat | 'tokens'>(() => {
    try {
      return (localStorage.getItem('planar:codeFormat') as CodeFormat) || 'react';
    } catch {
      return 'react';
    }
  });
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => {
    if (!open) return '';
    try {
      return format === 'tokens' ? generateTokens(editor.doc, 'css') : generateCode(editor.doc, id, format).code;
    } catch (e) {
      return `/* ${(e as Error).message} */`;
    }
    // Regenerate whenever the document changes.
  }, [open, format, id, editor.version]);

  return (
    <Section
      title="Code"
      actions={
        <button type="button" className="link-button" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </button>
      }
    >
      {open && (
        <>
          <div className="row">
            <select
              aria-label="Code format"
              value={format}
              onChange={(e) => {
                const f = e.target.value as CodeFormat | 'tokens';
                setFormat(f);
                try {
                  localStorage.setItem('planar:codeFormat', f);
                } catch {
                  // Preference only.
                }
              }}
            >
              <option value="react">React + CSS</option>
              <option value="html">HTML + CSS</option>
              <option value="css">CSS</option>
              <option value="tokens">Tokens (CSS variables)</option>
            </select>
            <button
              type="button"
              className="small-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(code);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch {
                  editor.notify('Select the code and copy it manually');
                }
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="code-view">{code}</pre>
        </>
      )}
    </Section>
  );
}
