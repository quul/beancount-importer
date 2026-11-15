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
2. **审阅** — 勾选"入账"决定哪些交易生成分录；分类和资金账户可逐笔修改，也可批量接受高置信度的建议。
3. **写入** — 点击"生成预览"，确认后点"校验并写入账本"。

重复的交易会自动标出，默认不入账，确认后可以解除。

## 账本配置

首次启动会自动查找工作区附近的 `accounting/main.bean`。也可以在页面的"账本设置"里修改账本路径、支付方式与账户的映射，或在启动时指定：

```bash
ACCOUNT_IMPORT_LEDGER_ROOT=/path/to/accounting ACCOUNT_IMPORT_PYTHON=/path/to/venv/bin/python pnpm start
```

写入格式默认按年度组织：

```text
main.bean
years/2025/2025.bean
years/2025/imported/2025-09.bean
```

## 测试

```bash
pnpm test
pnpm build
```
