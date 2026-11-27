// Relay's component kit, written in the shadcn/ui pattern (source in the repo, Radix for behaviour,
// class-variance-authority for variants, Tailwind tokens from index.css).
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { Loader2, X } from "lucide-react";
import * as React from "react";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// ───────── Button ─────────
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-ink text-white hover:bg-ink-2",
        move: "bg-move text-white hover:bg-[#cf4f0b]",
        outline: "border border-line-strong bg-surface text-ink hover:bg-sunk",
        ghost: "text-ink hover:bg-sunk",
        danger: "bg-danger text-white hover:bg-[#9a1e14]",
        "danger-outline": "border border-[#e7b6b0] bg-surface text-danger hover:bg-danger-soft",
        link: "px-0 text-ink underline underline-offset-4 hover:text-ink-2",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-4", lg: "h-11 px-5 text-[15px]", icon: "size-9" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);
export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean; busy?: boolean };
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, busy, children, disabled, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || busy} aria-busy={busy || undefined} {...props}>
      {asChild ? (
        children
      ) : (
        <>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {children}
        </>
      )}
    </Comp>
  );
});
Button.displayName = "Button";

// ───────── Badge ─────────
const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3", {
  variants: {
    tone: {
      neutral: "bg-sunk text-ink-2",
      danger: "bg-danger-soft text-danger",
      warn: "bg-warn-soft text-warn",
      info: "bg-info-soft text-info",
      ok: "bg-ok-soft text-ok",
      move: "bg-move-soft text-[#b8460a]",
      ai: "bg-ai-soft text-ai",
      outline: "border border-line-strong text-muted",
    },
  },
  defaultVariants: { tone: "neutral" },
});
export const Badge = ({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) => <span className={cn(badgeVariants({ tone }), className)} {...props} />;

// ───────── Surfaces ─────────
export const Panel = ({ className, ...props }: React.HTMLAttributes<HTMLElement>) => <section className={cn("rounded-lg border border-line bg-surface", className)} {...props} />;
export const PanelHeader = ({ title, action, className, children }: { title: React.ReactNode; action?: React.ReactNode; className?: string; children?: React.ReactNode }) => (
  <header className={cn("flex items-start justify-between gap-3 border-b border-line px-4 py-3", className)}>
    <div className="min-w-0">
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      {children && <div className="mt-0.5 text-sm text-muted">{children}</div>}
    </div>
    {action}
  </header>
);

// ───────── Form controls ─────────
const field = "w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-ink focus:outline-none disabled:opacity-60";
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn(field, "h-9", className)} {...p} />);
Input.displayName = "Input";
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} className={cn(field, "min-h-20 py-2 leading-relaxed", className)} {...p} />);
Textarea.displayName = "Textarea";
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => <select ref={ref} className={cn(field, "h-9 pr-8", className)} {...p} />);
Select.displayName = "Select";
export const Label = ({ className, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label className={cn("mb-1 block text-sm font-medium text-ink", className)} {...p} />;
export const Hint = ({ className, ...p }: React.HTMLAttributes<HTMLParagraphElement>) => <p className={cn("mt-1 text-xs text-muted", className)} {...p} />;

// ───────── Dialog (Radix) ─────────
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export function DialogContent({ title, description, children, className }: { title: string; description?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40" />
      <DialogPrimitive.Content className={cn("fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-surface p-5 shadow-xl", className)}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            {description && <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description>}
          </div>
          <DialogPrimitive.Close className="rounded p-1 text-muted hover:bg-sunk" aria-label="Close">
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// ───────── Feedback ─────────
export const Notice = ({ tone = "neutral", icon, title, children, className }: { tone?: "neutral" | "danger" | "warn" | "info" | "ok" | "ai" | "move"; icon?: React.ReactNode; title?: React.ReactNode; children?: React.ReactNode; className?: string }) => {
  const tones = {
    neutral: "border-line bg-sunk text-ink-2",
    danger: "border-[#f0c4be] bg-danger-soft text-danger",
    warn: "border-[#f1d9b0] bg-warn-soft text-warn",
    info: "border-[#c9dcf2] bg-info-soft text-info",
    ok: "border-[#c3e2cb] bg-ok-soft text-ok",
    ai: "border-[#d5daf0] bg-ai-soft text-ai",
    move: "border-[#f6c9ab] bg-move-soft text-[#a4400a]",
  } as const;
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={cn("flex gap-3 rounded-md border px-3 py-2.5 text-sm", tones[tone], className)}>
      {icon && <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && "mt-0.5", "text-ink-2")}>{children}</div>}
      </div>
    </div>
  );
};
export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn("size-4 animate-spin text-muted", className)} aria-label="Loading" />;
export const Empty = ({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) => (
  <div className="flex flex-col items-center px-6 py-10 text-center">
    <p className="font-medium text-ink">{title}</p>
    {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);
