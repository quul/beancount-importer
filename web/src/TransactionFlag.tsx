const flags = [
  { value: "*", name: "正常" },
  { value: "!", name: "待核实" },
] as const;

export default function TransactionFlag({ value, label, disabled, onChange }: {
  value: "*" | "!";
  label: string;
  disabled?: boolean;
  onChange: (value: "*" | "!") => void;
}) {
  return <span className="transaction-flag" role="group" aria-label={label}>
    {flags.map(({ value: flag, name }) => <button key={flag} type="button" aria-label={name} title={name}
      aria-pressed={value === flag} data-flag={flag} disabled={disabled} onClick={() => onChange(flag)}>{flag}</button>)}
  </span>;
}
