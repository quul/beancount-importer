# Bean Import Web — 账单导入 Web UI

对 `beancount-import-auto`（Python CLI 版）的重构与增强。用 TypeScript 实现：
Express 后端 + React 前端，把「导入账单」从终端逐条确认的批处理脚本变成可审阅的 Web 流程。

## 相对原版的增强

| # | 原版问题 | 本版方案 |
|---|---------|---------|
| 1 | 无去重：支付宝里"工行卡(1234)支付"和工行流水同一笔会重复入账；重复导入文件也无幂等 | 两级去重引擎：跨账单指纹（日期+金额+方向，按来源优先级保留信息最全的一条）+ 账本内查重（重复导入自动标记跳过） |
| 2 | 一家银行只能映射一个账户，借贷卡不分 | `assetMapping` 支持多卡（按卡号后缀区分）；`kind: debit/credit` 区分借记/信用卡（信用卡 → Liabilities） |
| 3 | 银行解析靠通用猜列名，PDF 基本不可用 | 六家银行（BOC/ABC/CZBank/SPDB/ICBC/CCB）专属列定义 + 通用兜底；新增云闪付解析 |
| 4 | `abs(amount)` 后方向丢失，收入被记成支出 | 借/贷方双列、收/支列、正负号三种方向判定；冒烟测试验证工资方向 |
| 5 | 不读已有账本 | 解析现有 beancount（含 include 链）：用历史交易做 payee→账户 few-shot 和分类记忆；生成前校验账户是否已 open |
| 6 | LLM 逐条调用、无置信度 | 批量 JSON 调用（20 条/批）、置信度 + 理由展示、用账本历史做 few-shot；本地规则/记忆优先，LLM 只兜底低置信度交易 |
| 7 | 余额列被丢弃 | 银行流水余额 → 自动生成 balance assertion |
| 8 | 终端 `input()` 逐条阻塞 | Web 表格批量审阅：标签页过滤、搜索、一键接受高置信度、逐笔改分类/资金账户 |
| 9 | 无 PDF 支持（PyPDF2 方案基本靠猜） | pdfjs-dist 坐标级解析：按 y 聚行、按 x 间隙分列、借/贷列语义、余额捕获（`parsers/pdf.ts`） |
| 10 | 转账/还款双腿各记一笔（虚增收支） | 转账配对引擎（`lib/transfers.ts`）：同额反向 ±2 天 + 还款/转账/充值关键词 → 合并为一条双腿 transfer，另一腿自动标记 |
| 11 | 无账本校验 | `/api/validate` 调 bean-check；导入完成页一键校验 |
| 12 | 需手动开 fava | `/api/fava` 一键启动 Fava（:5000） |

## 使用

```bash
pnpm install
pnpm dev        # server :8787 + vite (web)
# 或
pnpm start      # 仅后端
```

流程：拖入账单文件 → 审阅表格（重复/低置信度高亮）→ 生成预览 → 写入账本（按月分卷 + 自动补 open + 自动 include）。

## 结构

```
src/shared/types.ts        # 前后端共享类型
src/server/
  index.ts                 # API: upload/decide/generate/commit/ledger/config/validate/fava
  config.ts                # 配置（server-data/config.json）
  parsers/                 # alipay / wechat / yunshanfu / banks(6行+generic) / pdf
  lib/
    dedup.ts               # 跨账单 + 账本级去重
    transfers.ts           # 转账/还款双腿配对
    ledger.ts              # 现有账本解析（open/txn/include/payee 索引）
    classify.ts            # 记忆 → 历史 → 规则 → LLM 批量分类
    accounts.ts            # 资金账户推断（多卡、借贷区分）
    generate.ts            # 生成 entries + balance assertion + open 建议
web/src/App.tsx            # 审阅 UI
scripts/smoke.ts           # 合成账单端到端测试（pnpm smoke）
```

## 测试

```bash
pnpm smoke         # 16 项断言：解析、方向、余额、去重、转账配对、PDF、生成
pnpm exec tsc --noEmit   # 类型检查
```

## 后续可做

- PDF 中文银行账单按行定制（当前通用网格方案对 BOC/CCB 的真实导出仍需调参）
- LLM 辅助"交易对账"：目前是规则配对，可加 LLM 二次确认模糊配对（金额差 ±1 元的手续费场景）
- 导入历史管理：批次撤销（目前 append-only）
