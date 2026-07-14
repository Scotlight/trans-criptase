#!/usr/bin/env node
// 生成/更新 embed-config.json，并打印安装位置（便于二次调试）。
// 供 install.ps1 / install.sh 调用，也可手动跑。三种用法：
//   带参（非交互，个人一行到位）：
//     node scripts/write-config.mjs --provider api --baseUrl https://.../v1 --apiKey sk-... --model BAAI/bge-m3
//   无参 + 真终端：进入交互问答（选档 → 逐项填），apiKey 只在你自己终端里输入，不进对话/日志
//   无参 + 非终端（被管道/AI 调用）或 --template：直接生成模板，不阻塞
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cfgPath = path.join(SKILL_DIR, 'embed-config.json')
const examplePath = path.join(SKILL_DIR, 'embed-config.example.json')
const indexRoot = path.join(SKILL_DIR, 'index')
const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
const serverPath = path.join(SKILL_DIR, 'scripts', 'mcp-server.mjs')
const libPath = path.join(SKILL_DIR, 'scripts', 'lib.mjs')

// 解析 --key value（value 缺失或又是 --flag 时按空串处理）
const argv = process.argv.slice(2)
const opts = {}
for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    const next = argv[i + 1]
    opts[k] = (next === undefined || next.startsWith('--')) ? '' : argv[++i]
}

const KEYS = ['provider', 'baseUrl', 'apiKey', 'model', 'rerankModel', 'localDtype']

// 读基底：已有配置优先，否则用 example 模板
const loadBase = () => JSON.parse(fs.readFileSync(fs.existsSync(cfgPath) ? cfgPath : examplePath, 'utf8'))
const save = (cfg) => fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4) + '\n')

function printPaths(note) {
    console.log('')
    console.log('── 安装位置（二次调试看这里）──')
    console.log(`  插件根目录 : ${SKILL_DIR}`)
    console.log(`  配置文件   : ${cfgPath}${note ? '  ' + note : ''}`)
    console.log(`  索引数据   : ${indexRoot}`)
    console.log(`  MCP 服务器 : ${serverPath}`)
    console.log(`  读取转录自 : ${projectsRoot}  （只读）`)
    console.log('  改配置后重建索引：node scripts/semantic.mjs index --force')
}

// 实测 embedding 是否可用：复用 lib.mjs 的 embedBatch（读模块级 CFG），
// 保存配置后 refreshConfig() 重载再嵌一小段。可用返回 {ok:true, dims}，否则 {ok:false, error}。
async function testEmbed() {
    try {
        const lib = await import(pathToFileURL(libPath).href)
        lib.refreshConfig()
        const vecs = await lib.embedBatch(['transcriptase 连通性自检'], true)
        const dims = vecs?.[0]?.length
        if (!dims) return { ok: false, error: '响应无有效向量' }
        return { ok: true, dims }
    } catch (e) {
        return { ok: false, error: String(e?.message || e) }
    }
}

async function interactive() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask = async (q, def) => {
        const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim()
        return a || def || ''
    }
    // 严格选档：非 1/2/3 重问，不静默兜底
    const askChoice = async () => {
        while (true) {
            console.log('')
            console.log('  1) 远程 API   —— OpenAI 兼容 embedding 端点，语义/混合检索')
            console.log('  2) 本地模型   —— 全程零上云，需先按 docs/local-model.md 下载模型')
            console.log('  3) 仅关键词   —— 不配 embedding，只用 --exact 子串检索（免 API）')
            const c = await ask('选哪一档', '1')
            if (c === '1' || c === '2' || c === '3') return c
            console.log(`  ⚠ 无效输入「${c}」，请输入 1、2 或 3`)
        }
    }

    console.log('transcriptase 配置向导（直接回车用默认值；apiKey 只留在本机终端，不进对话）')

    // 主循环：远程/本地档配好后自动测通，不可用则打印日志、回退到选档第一关
    while (true) {
        const choice = await askChoice()
        const cfg = loadBase()

        if (choice === '3') {
            cfg.provider = 'api'
            cfg.apiKey = ''
            save(cfg)
            console.log('  → 仅关键词档：跳过 API 配置。建索引用 node scripts/semantic.mjs index --no-embed')
            console.log(`\n已写入 ${cfgPath}`)
            break
        }

        let skipTest = false
        if (choice === '2') {
            cfg.provider = 'local'
            cfg.localDtype = await ask('本地模型量化档 (fp32/q8/int8)', cfg.localDtype || 'q8')
            console.log('  → 需先按 docs/local-model.md 把模型文件放进 embedder/models/<模型ID>/')
        } else {
            cfg.provider = 'api'
            cfg.baseUrl = await ask('embedding 端点 baseUrl（以 /v1 结尾）', cfg.baseUrl)
            const key = await ask('apiKey（回车跳过 = 改用环境变量 TRANS_EMBED_API_KEY）', '')
            if (key) cfg.apiKey = key
            cfg.model = await ask('embedding 模型', cfg.model || 'BAAI/bge-m3')
            cfg.rerankModel = await ask('精排模型（回车留空 = 不精排）', cfg.rerankModel || 'BAAI/bge-reranker-v2-m3')
            // 没填 key 且环境变量也没有 → 无从测起，跳过（不算失败）
            if (!key && !process.env.TRANS_EMBED_API_KEY) {
                skipTest = true
                console.log('  → 未提供 apiKey：将走环境变量 TRANS_EMBED_API_KEY，跳过连通性测试')
            }
        }

        save(cfg)

        if (skipTest) { console.log(`\n已写入 ${cfgPath}`); break }

        console.log('\n正在测试 embedding 连通性…')
        const r = await testEmbed()
        if (r.ok) {
            console.log(`  ✓ 可用（返回 ${r.dims} 维向量）`)
            console.log(`已写入 ${cfgPath}`)
            break
        }
        console.log('  ✗ 不可用，错误日志：')
        for (const ln of r.error.split('\n')) console.log(`    ${ln}`)
        if (choice === '2') {
            console.log('  提示：本地档常见病因——模型文件未放到 embedder/models/<模型ID>/、dtype 与文件名不符（见 docs/local-model.md）')
        } else {
            console.log('  提示：远程档常见病因——baseUrl 未以 /v1 结尾、apiKey 错误、模型名不被端点支持、网络不通')
        }
        console.log('  ↩ 回到配置向导重选/重填。\n')
        // 循环回到 askChoice()
    }

    rl.close()
    printPaths()
}

const overrides = KEYS.filter(k => opts[k] !== undefined && opts[k] !== '')
const wantTemplate = opts.template !== undefined || opts.yes !== undefined

if (overrides.length) {
    // 带参：非交互套用覆盖项
    const cfg = loadBase()
    const set = []
    for (const k of overrides) {
        cfg[k] = opts[k]
        set.push(k === 'apiKey' ? 'apiKey(已隐藏)' : `${k}=${opts[k]}`)
    }
    save(cfg)
    console.log(`${fs.existsSync(cfgPath) ? '已更新' : '已生成'} 配置`)
    console.log('  设置：' + set.join('，'))
    printPaths()
} else if (!wantTemplate && process.stdin.isTTY) {
    // 无参 + 真终端：交互向导
    await interactive()
} else {
    // 无参 + 非终端 / --template：生成模板不阻塞
    if (fs.existsSync(cfgPath)) {
        console.log(`保留现有配置（未传参数）`)
    } else {
        fs.copyFileSync(examplePath, cfgPath)
        console.log(`已生成配置模板 —— 按需填 baseUrl/apiKey，或 provider 改 local（见 docs/local-model.md）`)
    }
    printPaths()
}
