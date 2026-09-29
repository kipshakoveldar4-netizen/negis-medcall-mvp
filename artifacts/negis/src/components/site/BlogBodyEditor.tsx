import { useRef, useState } from "react";
import { Heading2, Heading3, List, ListOrdered } from "lucide-react";

export function insertArticleBlock(value: string, start: number, end: number, prefix: string, label: string) {
  const content = value.slice(start, end) || label;
  const before = start > 0 ? "\n\n" : "";
  const block = `${before}${prefix}${content}\n\n`;
  const next = value.slice(0, start) + block + value.slice(end);
  if (next.length > 30000) return null;
  return { value: next, selectionStart: start + before.length + prefix.length,
    selectionEnd: start + before.length + prefix.length + content.length };
}

export function BlogBodyEditor({ value, onChange, inputClass, buttonClass }: {
  value: string; onChange(value: string): void; inputClass: string; buttonClass: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState("");
  function insertBlock(prefix: string, label: string) {
    const input = textarea.current;
    if (!input) return;
    const next = insertArticleBlock(value, input.selectionStart, input.selectionEnd, prefix, label);
    if (!next) { setError("Текст статьи не должен превышать 30 000 символов."); return; }
    setError("");
    onChange(next.value);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  }
  return <div className="min-w-0 space-y-2">
    <label htmlFor="blog-body" className="block text-sm">Текст статьи</label>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Структура статьи">
      <button type="button" className={buttonClass} title="Заголовок раздела" aria-label="Заголовок раздела" onClick={() => insertBlock("## ", "Название раздела")}><Heading2 size={18} /></button>
      <button type="button" className={buttonClass} title="Подзаголовок" aria-label="Подзаголовок" onClick={() => insertBlock("### ", "Подзаголовок")}><Heading3 size={18} /></button>
      <button type="button" className={buttonClass} title="Маркированный список" aria-label="Маркированный список" onClick={() => insertBlock("- ", "Пункт списка")}><List size={18} /></button>
      <button type="button" className={buttonClass} title="Нумерованный список" aria-label="Нумерованный список" onClick={() => insertBlock("1. ", "Пункт списка")}><ListOrdered size={18} /></button>
    </div>
    <textarea ref={textarea} id="blog-body" className={`${inputClass} min-h-72`} rows={14} maxLength={30000} value={value} onChange={event => { setError(""); onChange(event.target.value); }} />
    {error && <p role="alert" className="text-sm text-[var(--negis-muted)]">{error}</p>}
  </div>;
}
