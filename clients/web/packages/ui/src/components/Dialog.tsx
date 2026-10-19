import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n';

/**
 * 对话框。关闭按钮排在内容后面（位置仍在右上角）：打开时焦点落在第一个输入框上，而不是关闭按钮。
 * narrow：只有几个输入框的小表单用窄一些的宽度
 */
export function Dialog({ open, onOpenChange, title, description, children, wide, narrow }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  narrow?: boolean;
}) {
  const t = useT();
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="app-no-drag fixed inset-0 z-40 bg-black/40" />
        <RD.Content
          className={`fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl sm:p-4 ${wide ? 'max-w-2xl' : narrow ? 'max-w-sm' : 'max-w-md'}`}
        >
          <div className="mb-4 pr-8">
            <RD.Title className="text-lg font-semibold [overflow-wrap:anywhere] sm:text-[15px]">{title}</RD.Title>
            {description ? <RD.Description className="mt-0.5 text-sm text-muted sm:text-xs">{description}</RD.Description> : <RD.Description className="sr-only">{title}</RD.Description>}
          </div>
          {children}
          <RD.Close className="absolute top-4 right-4 rounded-md p-1 text-muted hover:bg-surface-2 sm:top-3 sm:right-3" aria-label={t('common.close')}>
            <X size={16} />
          </RD.Close>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
