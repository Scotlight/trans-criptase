# 本地模型配置教程（全程零上云）

本地档用 [transformers.js](https://github.com/huggingface/transformers.js)（ONNX Runtime，纯 Node，不需要 Python/Ollama/显卡）在你的 CPU 上跑 embedding。嵌入器里 `allowRemoteModels=false` 是焊死的——**配置错了它只会报错，绝不会偷偷联网**。

## 第 1 步：装运行时（一次性）

```powershell
cd embedder
npm install          # 只装 @huggingface/transformers，约 100MB（含 ONNX 运行时）
```

## 第 2 步：选模型

| 模型 | 体积 | 维度 | 适合 | localDtype |
|---|---|---|---|---|
| `Xenova/bge-small-zh-v1.5` | **~24MB**(q8) | 512 | 中文为主，首选 | `"q8"` |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | ~120MB(q8) | 384 | 中英混杂 | `"q8"` |
| `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | ~450MB(fp32) | 384 | 同上，官方原版 | `"fp32"` |

不确定就选第一个：小、快、中文效果最好。

## 第 3 步：下载模型文件（最容易踩坑的一步）

每个模型需要 **5 个文件**，都在模型仓库的 Files and versions 页：

```
config.json
tokenizer.json                  ← 最大的小文件，多语模型 ~17MB
tokenizer_config.json
special_tokens_map.json
onnx/model_quantized.onnx       ← q8 用这个；fp32 用 onnx/model.onnx
```

⚠️ **dtype 和文件名必须对应**：`localDtype: "q8"` → 找 `model_quantized.onnx`；`"fp32"` → 找 `model.onnx`。onnx 文件夹里的其他变体（`model_O1.onnx`、`model_qint8_avx512.onnx`…）都不要。

### 下载渠道（按优先级试）

1. **HuggingFace 官方** `https://huggingface.co/<模型ID>/tree/main` —— 网络通就最省事
2. **hf-mirror** `https://hf-mirror.com/<模型ID>/tree/main` —— 注意：小文件（config 等）一定能下，**大文件（onnx、tokenizer.json）走 HF 的 Xet CDN**，部分网络出口会 403，镜像也救不了
3. **ModelScope 魔搭** `https://modelscope.cn` 搜模型名 —— 国内 CDN，很多 HF 仓库有镜像；文件地址格式 `https://modelscope.cn/models/<org>/<name>/resolve/master/<文件路径>`
4. 手机热点 / 换个网络出口 —— Xet CDN 的 403 是按出口 IP 拒的，换出口经常就通了

> 你看到浏览器里 `<Error><Code>AccessDenied</Code></Error>` 就是 Xet CDN 403，跟你的操作无关，换渠道。

## 第 4 步：摆文件

放进 `embedder/models/<完整模型ID>/`，**目录名必须和模型 ID 完全一致**（含组织名）：

```
embedder/
└── models/
    └── Xenova/
        └── bge-small-zh-v1.5/
            ├── config.json
            ├── tokenizer.json
            ├── tokenizer_config.json
            ├── special_tokens_map.json
            └── onnx/
                └── model_quantized.onnx
```

## 第 5 步：改配置

`embed-config.json`：

```jsonc
{
    "provider": "local",                       // ← 关键开关
    "model": "Xenova/bge-small-zh-v1.5",       // ← 与目录名一致
    "localDtype": "q8",                        // ← 与 onnx 文件名对应
    "localEmbedder": "embedder/embedder.mjs",
    "rerankModel": ""                          // 本地档没有 reranker，留空
}
```

## 第 6 步：验证

```powershell
# 冒烟：应输出维度和一对相似度（相关 > 无关 就对了）
node -e "const {embed}=await import('./embedder/embedder.mjs');const v=await embed(['侧栏宽度拖拽','今天吃什么'],{model:'Xenova/bge-small-zh-v1.5',dtype:'q8'});const q=await embed(['目录栏加宽'],{model:'Xenova/bge-small-zh-v1.5',dtype:'q8',isQuery:true});const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);console.log('维度',v[0].length,'相关',dot(q[0],v[0]).toFixed(3),'无关',dot(q[0],v[1]).toFixed(3))" --input-type=module

# 全量重建索引（本地 CPU，700 块约 1~2 分钟，之后增量秒级）
node scripts/semantic.mjs index --force

# 查询
node scripts/semantic.mjs query "上次那个断线的会话改到哪了"
```

## 原理备注（不看不影响使用）

- **pooling 自动适配**：bge 系用 CLS，其余用 mean——嵌入器按模型名自己选，不用配
- **bge 中文查询前缀**：bge-zh 系模型检索时查询端要加指令前缀「为这个句子生成表示…」，嵌入器对 query 自动加、对文档不加
- **换模型 = 自动重建**：索引头记录了模型名，`model` 一改，下次 `index` 自动全量重建，不会出现新旧向量混存
- **性能预期**：首次加载模型 2~5 秒（之后进程内复用）；q8 小模型单条 embedding 约 5~20ms

## 常见问题

**装 npm 包时下载 onnxruntime 很慢/失败？**
`npm config set registry https://registry.npmmirror.com` 后重装。

**跑起来报 `Could not locate file ...`？**
目录名和模型 ID 不一致，或 dtype 与 onnx 文件名不匹配（见第 3、4 步的对应表）。

**质量不如远程 bge-m3？**
是的，小模型换隐私的正常代价。缓解：混合模式的关键词腿不受影响；查询措辞尽量贴近原话；`--exact` 抓精确串永远可靠。
