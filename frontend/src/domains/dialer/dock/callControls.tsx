import { useState, type ReactNode } from "react";
import { Keyboard, Mic, MicOff, Pause, Play, type IconComponent } from "@/domains/ui/icons";
import { useDialer } from "@/domains/dialer/provider";

export function ControlButton({
  icon: Icon, label, active, disabled, title, onClick,
}: {
  icon: IconComponent;
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-pressed={active}
      className={`h-16 rounded-md flex flex-col items-center justify-center gap-1 text-[12px] font-semibold transition disabled:opacity-40 ${
        active ? "bg-[var(--ods-brand-600)] text-white" : "bg-[var(--ods-bg-tertiary)] hover:bg-[var(--ods-hover)] text-[var(--ods-text-primary)]"
      }`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );
}

const KEYS = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
];

export function Keypad({ onKey, disabled = false }: { onKey: (key: string) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Phone keypad">
      {KEYS.map(([key, sub]) => (
        <button
          type="button"
          key={key}
          aria-label={key}
          disabled={disabled}
          onClick={() => onKey(key)}
          className="h-12 rounded-md bg-[var(--ods-bg-tertiary)] hover:bg-[var(--ods-hover)] active:bg-[var(--ods-active)] flex flex-col items-center justify-center disabled:opacity-40"
        >
          <span className="text-xl font-semibold leading-none">{key}</span>
          {sub && <span className="text-[12px] font-semibold tracking-wider text-[var(--ods-text-tertiary)] mt-0.5">{sub}</span>}
        </button>
      ))}
    </div>
  );
}

export function CallControls({ children }: { children?: ReactNode }) {
  const d = useDialer();
  const [keypadOpen, setKeypadOpen] = useState(false);
  const connected = d.state === "active" || d.state === "on_hold";
  const browserControls = connected && !d.phoneAudio;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <ControlButton
          icon={d.muted ? MicOff : Mic}
          label={d.muted ? "Unmute" : "Mute"}
          active={d.muted}
          disabled={!browserControls}
          title={d.phoneAudio ? "Mute on your phone (phone audio)" : undefined}
          onClick={d.mute}
        />
        <ControlButton
          icon={d.held ? Play : Pause}
          label={d.held ? "Resume" : "Hold"}
          active={d.held}
          disabled={!browserControls}
          title={d.phoneAudio ? "Hold on your phone (phone audio)" : undefined}
          onClick={d.hold}
        />
        <ControlButton
          icon={Keyboard}
          label="Keypad"
          active={keypadOpen}
          disabled={!browserControls}
          title={d.phoneAudio ? "Use the keypad on your phone (phone audio)" : undefined}
          onClick={() => setKeypadOpen((open) => !open)}
        />
        {children}
      </div>
      {d.phoneAudio && <p className="text-[12px] text-[var(--ods-text-secondary)]">Use your phone to mute, hold or enter keypad digits.</p>}
      {keypadOpen && <Keypad onKey={d.sendDtmf} disabled={!browserControls} />}
    </div>
  );
}
