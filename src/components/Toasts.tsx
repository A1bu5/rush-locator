// 轻量 Toast 通知

import { useRef, useState } from 'react';
import { IconAlert, IconCheck, IconInfo, IconX } from './icons';

export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(1);

  const push = (text: string, kind: ToastItem['kind'] = 'info') => {
    const id = idRef.current++;
    setToasts((list) => [...list.slice(-3), { id, kind, text }]);
    const ttl = kind === 'error' ? 7000 : 3600;
    window.setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, ttl);
  };

  const dismiss = (id: number) => setToasts((list) => list.filter((t) => t.id !== id));

  return { toasts, push, dismiss };
}

export function Toasts({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="toasts">
      {items.map((t) => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const icon =
    item.kind === 'success' ? <IconCheck /> : item.kind === 'error' ? <IconAlert /> : <IconInfo />;
  return (
    <div className={`toast ${item.kind}`} onClick={() => onDismiss(item.id)}>
      {icon}
      <span>{item.text}</span>
      <span className="close" style={{ marginLeft: 'auto' }}>
        <IconX style={{ width: 12, height: 12 }} />
      </span>
    </div>
  );
}
