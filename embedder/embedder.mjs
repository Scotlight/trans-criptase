// trans 本地嵌入器：transformers.js(ONNX)，纯本地零上云（allowRemoteModels=false 绝不联网）
// 被 ~/.claude/skills/trans/scripts/lib.mjs 按 embed-config.json 的 localEmbedder 路径动态加载
// 模型文件手动放入 ./models/<模型ID>/，如:
//   models/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/
//     ├── config.json / tokenizer.json / tokenizer_config.json
//     └── onnx/model.onnx        (fp32；若是 model_quantized.onnx 则 localDtype 填 "q8")
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline, env } from '@huggingface/transformers'

const here = path.dirname(fileURLToPath(import.meta.url))
env.localModelPath = path.join(here, 'models')
env.cacheDir = path.join(here, 'models')
env.allowLocalModels = true
env.allowRemoteModels = false

const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'
const extractors = new Map()

const poolingFor = (model) => /bge/i.test(model) ? 'cls' : 'mean'

async function getExtractor(model, dtype) {
    const key = model + '|' + dtype
    if (!extractors.has(key)) {
        extractors.set(key, await pipeline('feature-extraction', model, { dtype }))
    }
    return extractors.get(key)
}

export async function embed(texts, opts = {}) {
    const model = opts.model || 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
    const dtype = opts.dtype || 'fp32'
    const ex = await getExtractor(model, dtype)
    const input = opts.isQuery && /bge-\S*zh/.test(model) ? texts.map(t => QUERY_PREFIX + t) : texts
    const out = await ex(input, { pooling: poolingFor(model), normalize: true })
    const dims = out.dims.at(-1)
    const n = out.dims.length === 2 ? out.dims[0] : 1
    const res = []
    for (let i = 0; i < n; i++) res.push(Array.from(out.data.slice(i * dims, (i + 1) * dims)))
    return res
}
