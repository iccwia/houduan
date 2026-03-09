const { NlpManager } = require("node-nlp");
const mysql = require("mysql2/promise");

// 数据库配置
const dbConfig = {
  host: "localhost",
  user: "root",
  password: "Aa2822587210",
  database: "新版问答",
};

const manager = new NlpManager({
  languages: ["zh"],
  forceNER: true,
  nlu: { log: false, useNoneFeature: true },
});

const CONCEPT_WHITELIST = new Set();

/**
 * 🚀 训练模型：从数据库加载合并后的意图
 */
async function trainModel() {
  console.log("🔄 [NLP] 正在从数据库加载动态策略语料...");
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);

    // 1. 加载意图 (来自 inquiry_scheme 表)
    // 此时 id=2 包含了 "提示" 和 "示例" 的所有关键词
    const [schemes] = await conn.execute(
      "SELECT schemeId, keywords FROM inquiry_scheme",
    );
    schemes.forEach((scheme) => {
      if (!scheme.keywords) return;
      const words = scheme.keywords.split(/,|，/);
      words.forEach((word) => {
        if (word.trim()) {
          // 以 schemeId 作为标签进行训练
          manager.addDocument("zh", word.trim(), scheme.schemeId.toString());
        }
      });
    });

    // 2. 加载知识点实体 (来自 knowledge 表)
    const [knowledgeList] = await conn.execute(
      "SELECT knowledgeName, keywords FROM knowledge",
    );
    CONCEPT_WHITELIST.clear();

    knowledgeList.forEach((row) => {
      let termSet = new Set();
      if (row.knowledgeName) {
        let cleanName = row.knowledgeName
          .replace(/概念|提示|定义|名称/g, "")
          .trim();
        if (cleanName) termSet.add(cleanName);
      }
      if (row.keywords) {
        row.keywords.split(/,|，/).forEach((k) => {
          if (k.trim()) termSet.add(k.trim());
        });
      }

      termSet.forEach((term) => {
        CONCEPT_WHITELIST.add(term.toLowerCase());
        const templates = [
          "什么是%s",
          "%s是什么",
          "不懂%s",
          "解释一下%s",
          "%s是啥",
        ];
        // 意图 ID 1 对应数据库中的 STRATEGY_CONCEPT
        templates.forEach((t) =>
          manager.addDocument("zh", t.replace("%s", term), "1"),
        );
      });
    });

    await manager.train();
    console.log("🚀 [NLP] 混合模型训练完成！");
  } catch (e) {
    console.error("❌ [NLP] 训练失败:", e);
  } finally {
    if (conn) await conn.end();
  }
}

/**
 * 辅助：提取实体
 */
function extractEntity(text) {
  const cleanText = text.replace(/[?？!.。]+$/, "").trim();
  const regexes = [
    /(?:什么是|解释|定义|说下)\s*(.+)/,
    /(.+?)\s*(?:是什么|是啥|定义|意思)/,
    /(?:不懂|不理解|解释下)\s*(.+)/,
  ];

  // 🔴 新增：无意义代词/停用词过滤，防止提取出“这”
  const stopWords = [
    "这",
    "这个",
    "那个",
    "这步",
    "这里",
    "它",
    "怎么做",
    "啥",
  ];

  for (const reg of regexes) {
    const match = cleanText.match(reg);
    if (match) {
      const candidate = match[1].trim();

      // 如果提取到的是代词，返回 null 交给后端做上下文推理
      if (stopWords.includes(candidate)) {
        return null;
      }

      if (
        CONCEPT_WHITELIST.has(candidate.toLowerCase()) ||
        (candidate.length >= 1 && candidate.length < 10)
      ) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * 意图识别入口
 */
async function analyzeIntentLocal(message) {
  if (!message) return { intent: null, entity: null };
  const msg = message.trim();

  // 1. 否定拦截
  if (/[不别非].{0,5}(下[一1]步|next|完成)/i.test(msg)) {
    return { intent: null, entity: null };
  }

  // 2. 实体优先
  const entity = extractEntity(msg);
  if (entity) return { intent: "1", entity };

  // 3. 模型预测
  const response = await manager.process("zh", msg);
  const threshold = msg.length < 4 ? 0.4 : 0.6;

  if (response.score > threshold && response.intent !== "None") {
    // 自动补全实体：如果是问概念 (ID:1) 但没提取出实体，把整句当作实体
    if (response.intent === "1") return { intent: "1", entity: msg };
    return { intent: response.intent, entity: null };
  }

  return { intent: null, entity: null };
}

module.exports = { trainModel, analyzeIntentLocal };
//测试提交
