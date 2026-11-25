import type { RefObject } from "react";
import type { ParsedAccount } from "../../src/shared/types.js";
import { isFundingAccount } from "../../src/shared/funding.js";
import SearchSelect from "./SearchSelect";

type AccountOption = Pick<ParsedAccount, "account" | "closedAt">;

export default function AccountSelect({ value, accounts, funding = false, placeholder = "搜索账户", ...props }: {
  value: string; accounts: AccountOption[]; onChange: (value: string) => void;
  disabled?: boolean; funding?: boolean; label: string; inputId?: string; placeholder?: string; validationMessage?: string;
  autoHighlight?: boolean; confirmCurrent?: boolean; matchReason?: string;
  optionsBottomBoundary?: RefObject<HTMLElement>;
}) {
  const allowed = funding ? accounts.filter(({ account }) => isFundingAccount(account)) : accounts;
  const current = value ? allowed.find((option) => option.account === value) : undefined;
  const hint = current?.closedAt ? `关闭于 ${current.closedAt}` : value && !current ? "未在账本定义" : undefined;
  const nameStart = value.lastIndexOf("-") + 1;
  const hasName = nameStart > 0 && nameStart < value.length;
  return <SearchSelect {...props} value={value} placeholder={placeholder} hint={hint}
    options={allowed.map(({ account, closedAt }) => ({ value: account, detail: closedAt ? `关闭于 ${closedAt}` : undefined }))}
    emptyMessage={allowed.length ? "没有匹配的账户" : "没有可用账户"} inputClassName={hasName ? "has-account-name" : undefined}
    selectedContent={hasName && <span className="account-selected-value" aria-hidden="true">
      <span className="account-path">{value.slice(0, nameStart)}</span>
      <span className="account-name">{value.slice(nameStart)}</span>
    </span>} />;
}
