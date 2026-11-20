# Bean Import — 账单审阅与过账

导入支付宝、微信和银行账单，逐笔审阅后写入 Beancount 账本。

## 快速开始

```bash
pnpm install
pnpm dev        # 开发模式：后端 :8787 + 前端 :5173
```

或构建后由后端直接提供页面：

```bash
pnpm build && pnpm start   # 访问 http://localhost:8787
```

## 使用流程

1. **上传** — 把解压好的 CSV / XLSX / PDF 拖进页面。
2. **审批** — 用「标记入账」和「排除此笔」决定哪些交易生成分录。分类与资金账户支持搜索，单笔交易可在「详情与备注」中添加备注。
3. **写入** — 点击"生成预览"，确认后点"校验并写入账本"。

重复的交易会自动标出，默认不入账，确认后可以解除。用「疑似重复入账」筛选查看账本或跨来源匹配产生的疑似记录。「重新载入」读取已保存的批次并按当前账本复查。可用「剔除疑似重复」批量排除当前批次中仍可入账的疑似重复交易。

## 账本配置

首次启动会自动查找工作区附近的 `accounting/main.bean`。点击右上角「设置」，在「账本设置」中修改账本路径，在「资金映射」中管理付款方式对应的账本账户。也可以在启动时指定账本路径：

```bash
ACCOUNT_IMPORT_LEDGER_ROOT=/path/to/accounting ACCOUNT_IMPORT_PYTHON=/path/to/venv/bin/python pnpm start
```

资金映射、主入口、导入子目录、Python 路径和其他应用设置统一保存在账本根目录的 `.beancount-importer.json`。如果配置了 LLM API 密钥，该密钥也保存在此文件中。打开另一个已有设置文件的账本时，会使用该账本的设置。旧项目设置在成功写入目标账本后移除。应用会在用户数据目录记住上次选择的账本路径，Windows 上是 `%LOCALAPPDATA%\BeancountImporter\active-ledger.json`。也可以用 `ACCOUNT_IMPORT_LEDGER_ROOT` 临时指定启动账本，例如在 PowerShell 中执行：

```powershell
$env:ACCOUNT_IMPORT_LEDGER_ROOT = 'D:\账本'
pnpm start
```

写入格式默认按年度组织：

```text
main.bean
years/2025/2025.bean
years/2025/imported/2025-09.bean
```

在安装了 PowerShell 7 的 Windows 本机运行时，可以在账本设置中选择账本文件夹和 Python 可执行文件。路径也可手动输入。

“导入子目录”支持 `{year}`（四位年份）、`{month}`（两位月份）、`{source}`（如 `alipay`）和 `{account}`（资金账户，冒号转为下划线）。例如，`years/{year}/{month}/{source}/{account}` 可生成 `years/2025/09/alipay/Assets_Bank/2025-09.bean`。生成预览时可查看每个目标文件。

## 微信账单识别规则

在 [`config/wechat-rules.json`](config/wechat-rules.json) 添加或修改微信账单规则。`when.category` 可填写一个原始交易类型或一组类型，还可设置收支方向 `direction`（`in` 为收入，`out` 为支出）、原始状态 `status` 和交易对方前缀 `payeePrefix`。

`exclude` 填写自动排除的原因，默认覆盖零钱与零钱通双向互转。新导入或重新打开未提交批次时，匹配的流水会归到「排除」。对于支付方式为空且可入账的流水，`label` 显示在审批页，`fundingMethod` 交由「资金映射」匹配账本账户。活动奖励默认推断为「零钱」。

## PDF 账单识别规则

[`config/pdf-rules.json`](config/pdf-rules.json) 的 `tables` 包含招行和中信信用卡账单规则。新增同类表格版式时，可复制一项并修改来源、正文特征和表头。每次上传都会重新读取配置。已保存的批次可通过重新上传原文件应用新规则。

- `documentPattern` 匹配 PDF 正文特征，`columns` 按从左到右声明表头和列用途。`offset` 相对于表头左边缘，启用 `fromPreviousRight` 后则相对于上一列表头右边缘，单位为 PDF 点。
- `datePattern` 匹配日期列。日期省略年份时，配置 `statementDate` 从账单日期推断。带 `date: "bookDate"` 的规则优先采用记账日。
- `amount.pattern` 用命名分组 `amount` 读取记账金额。`currency` 分组、`currencyByHeader` 或固定 `currency` 提供币种。`originalAmount` 列与记账金额不同时会保留在备注里。
- `descriptionWindow` 控制描述续行的合并范围和跨页续接距离。`account` 定义卡号尾号格式和资金映射用的名称。`rules` 按顺序匹配还款、退款和返现等交易类型。
- `fallback` 为通用流水版式配置金额、方向和可忽略的文本。

## 测试

```bash
pnpm test
pnpm build
```
