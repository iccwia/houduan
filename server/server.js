const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const { trainModel, analyzeIntentLocal } = require("./nlp-local");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 静态资源托管
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const dbConfig = {
  host: "localhost",
  user: "root",
  password: "Aa2822587210",
  database: "新版问答",
  waitForConnections: true,
  connectionLimit: 10,
};
const pool = mysql.createPool(dbConfig);

const sessions = {};
const getSession = (userId) => {
  if (!sessions[userId])
    sessions[userId] = { questionId: 1, currentStepOrder: 1, counters: {} };
  return sessions[userId];
};

const INTERACTION_WORDS = {
  greetings: [
    "你好呀！我是你的智能助教 🤖，准备好开始学习了吗？",
    "嗨！很高兴见到你 ✨。有什么我可以帮你的吗？",
    "你好！今天我们一起来攻克编译原理的难关吧 🚀",
    "哈喽！我是你的专属 AI 导师，随时待命 🙋‍♂️",
  ],
  encouragements: [
    "别灰心，这部分逻辑确实有些抽象，我们再试一次 💪",
    "没关系的，学习本身就是不断尝试的过程 🌟",
    "你已经进行到这一步了，很棒！让我们看看哪里卡住了 🌈",
    "别急，深呼吸。我们一起拆解一下这个问题 🧩",
    "没关系，很多同学在这里都会遇到挑战，你并不孤单 🤝",
  ],
  navigation: [
    "好的，没问题！👌",
    "明白，这就为你切换。🚀",
    "没问题，我们继续前进。➡️",
    "好的，让我们回头看看。⬅️",
  ],
};

function getRandomWord(type) {
  const list = INTERACTION_WORDS[type];
  return list[Math.floor(Math.random() * list.length)];
}

function resolveMediaUrl(loc) {
  if (!loc) return null;
  const cleanLoc = loc.trim();
  if (cleanLoc.startsWith("http")) return cleanLoc;
  return `http://localhost:3000/uploads/${cleanLoc}`;
}

/**
 * 🧠 核心策略处理器
 */
async function executeStrategy(session, strategyId, userMessage) {
  if (!strategyId) return "抱歉，该场景尚未配置回复策略。";

  const [res] = await pool.execute(
    "SELECT * FROM respond_strategy WHERE strategyId = ?",
    [strategyId]
  );
  if (res.length === 0) return "策略配置错误。";

  const strategy = res[0];
  const { questionId, currentStepOrder, counters } = session;

  switch (strategy.strategyType) {
    case "STRATEGY_CONCEPT":
      let k = [];
      // 🔴 新增：判定用户的话是否是模糊的代词或短语
      const vagueWords = [
        "这",
        "这个",
        "那个",
        "这是什么",
        "什么意思",
        "这是啥",
        "这啥",
        "意思",
      ];
      const isVague =
        vagueWords.includes(userMessage.trim()) || userMessage.length < 2;

      // 阶段 1：如果不是模糊提问，尝试精准查询知识点
      if (!isVague) {
        const [exactRes] = await pool.execute(
          `
          SELECT * FROM knowledge 
          WHERE keywords != '' AND (
             ? LIKE CONCAT('%', keywords, '%') 
             OR keywords LIKE CONCAT('%', ?, '%')
             OR ? LIKE CONCAT('%', knowledgeName, '%')
          ) LIMIT 1
        `,
          [userMessage, userMessage, userMessage]
        );
        k = exactRes;
      }

      // 阶段 2：如果精准查询失败，或者用户提问模糊 (如：这是什么)，进行【上下文推断】
      if (k.length === 0) {
        // 2.1 尝试通过问题步骤绑定表 (problem_step_knowledge) 找对应的知识点
        const [ctxRes] = await pool.execute(
          `
          SELECT k.* FROM knowledge k
          JOIN problem_step_knowledge psk ON k.knowledgeId = psk.knowledgeId
          WHERE psk.problemId = ? AND psk.stepId = ? LIMIT 1
          `,
          [questionId, currentStepOrder]
        );

        if (ctxRes.length > 0) {
          k = ctxRes;
          k[0].isContextual = true; // 打上上下文标记
        } else {
          // 2.2 如果没硬绑定，智能读取当前步骤的文字进行反向提取 (如：步骤写了"写出字母表"，自动匹配"字母表概念")
          const [steps] = await pool.execute(
            "SELECT stepContent FROM problem_step WHERE problemId=? AND stepId=?",
            [questionId, currentStepOrder]
          );
          if (steps.length > 0) {
            const stepContent = steps[0].stepContent;
            const [textRes] = await pool.execute(
              `SELECT * FROM knowledge WHERE ? LIKE CONCAT('%', REPLACE(knowledgeName, '概念', ''), '%') LIMIT 1`,
              [stepContent]
            );
            if (textRes.length > 0) {
              k = textRes;
              k[0].isContextual = true;
            }
          }
        }
      }

      if (k.length > 0) {
        const item = k[0];

        // 🔴 新增：如果是推断出来的，改变话术，体现智能感
        let reply = item.isContextual
          ? `💡 我猜你是在问当前任务相关的概念：\n\n🎓 **概念解析：${
              item.knowledgeName
            }**\n\n${item.domainExample || item.definition || ""}`
          : `🎓 **概念解析：${item.knowledgeName}**\n\n${
              item.domainExample || item.definition || ""
            }`;

        // 🖼 1. 处理讲义/参考图片
        if (item.ppt_loc) {
          const pptUrl = resolveMediaUrl(item.ppt_loc);
          reply += `\n\n---\n📖 **相关讲义/参考资料**：\n`;

          const isImage =
            item.ppt_loc.match(/\.(jpeg|jpg|gif|png|webp|bmp)$/i) ||
            item.ppt_loc.toLowerCase().includes("jpeg") ||
            item.ppt_loc.toLowerCase().includes("png") ||
            item.ppt_loc.toLowerCase().includes("img");

          if (isImage) {
            reply += `![讲义内容预览](${pptUrl})`;
          } else {
            reply += `🔗[点击查看详细资料页面](${pptUrl})`;
          }
        }

        // 🎥 2. 处理视频 (一律改为跳转链接)
        if (item.videoclip_id) {
          const videoUrl = resolveMediaUrl(item.videoclip_id);
          const timeRange =
            item.vsection_b && item.vsection_e
              ? ` (建议观看时段: ${item.vsection_b} - ${item.vsection_e})`
              : "";

          reply += `\n\n🎬 **推荐微课视频**${timeRange}：\n`;
          reply += `▶️[立即跳转观看视频](${videoUrl})`;
        }

        return reply;
      }
      return "🤔 没找到相关概念。你能具体说明想了解哪个名词吗？（如：“什么是字母表”）";

    case "STRATEGY_GRADED_AID":
      const helpCount = counters["2"] || 0;
      if (helpCount <= 1) {
        const [steps] = await pool.execute(
          "SELECT stepExample FROM problem_step WHERE problemId = ? AND stepId = ?",
          [questionId, currentStepOrder]
        );
        if (steps.length > 0 && steps[0].stepExample) {
          return `📖 **类比提示**：\n\n${steps[0].stepExample}\n\n👉 这是一个类似的例子，你可以参考它的思路。`;
        }
      }
      const [errors] = await pool.execute(
        `
        SELECT ss.stepContent, ss.stepComment FROM solution s
        JOIN solution_step ss ON s.solutionId = ss.solutionId
        WHERE s.problemId = ? AND s.isTypicalCase = 1 AND ss.stepId = ?
        ORDER BY RAND() LIMIT 1
      `,
        [questionId, currentStepOrder]
      );
      if (errors.length > 0) {
        return `⚠️ **易错预警（往届典型错误）**：\n\n一位同学曾这样回答：\n> \`${errors[0].stepContent}\`\n\n助教点评：\n**${errors[0].stepComment}**\n\n请检查你是否也存在类似问题？`;
      }
      return "💡 已经给出了所有参考信息，请结合前面的提示自己尝试思考，或进入下一步。";

    case "STRATEGY_STEP_GUIDE":
      const [stepInfo] = await pool.execute(
        "SELECT stepContent FROM problem_step WHERE problemId=? AND stepId=?",
        [questionId, currentStepOrder]
      );
      if (stepInfo.length > 0) {
        return `👉 **当前任务 (Step ${currentStepOrder})**：\n${stepInfo[0].stepContent}`;
      }
      return "这一步的任务似乎还没定义。";

    case "STRATEGY_EMOTION":
      const encouragement = getRandomWord("encouragements");
      return (
        `${encouragement}\n\n我们一起来看这一步：\n` +
        (await executeStrategy(session, 2, userMessage))
      );

    default:
      return "收到。";
  }
}

/**
 * 🤖 对话主处理器
 */
async function handleUserMessage(userId, message) {
  try {
    const session = getSession(userId);
    const { intent, entity } = await analyzeIntentLocal(message);
    const schemeId = intent ? parseInt(intent) : null;

    const getCurrentStepGuide = async (s) => {
      const [steps] = await pool.execute(
        "SELECT stepContent FROM problem_step WHERE problemId=? AND stepId=?",
        [s.questionId, s.currentStepOrder]
      );
      return steps.length > 0 ? steps[0].stepContent : "暂无任务描述";
    };

    if (schemeId === 6) {
      session.currentStepOrder++;
      session.counters = {};
      const stepContent = await getCurrentStepGuide(session);
      return {
        text: `${getRandomWord("navigation")} \n\n✅ 已经进入 **Step ${
          session.currentStepOrder
        }**。\n\n📢 **新任务**：\n${stepContent}`,
        currentStep: session.currentStepOrder,
      };
    }
    if (schemeId === 7) {
      if (session.currentStepOrder > 1) session.currentStepOrder--;
      session.counters = {};
      const stepContent = await getCurrentStepGuide(session);
      return {
        text: `${getRandomWord("navigation")} \n\n👌 已回到 **Step ${
          session.currentStepOrder
        }**。\n\n📢 **任务回顾**：\n${stepContent}`,
        currentStep: session.currentStepOrder,
      };
    }
    if (schemeId === 8) {
      session.currentStepOrder = 1;
      session.counters = {};
      const stepContent = await getCurrentStepGuide(session);
      return {
        text: `🔄 进度已重置。让我们从 **Step 1** 重新开始吧！\n\n📢 **初始任务**：\n${stepContent}`,
        currentStep: 1,
      };
    }
    if (schemeId === 9) {
      const greeting = getRandomWord("greetings");
      const stepContent = await getCurrentStepGuide(session);
      return {
        text: `${greeting}\n\n你当前正在执行 **Step ${session.currentStepOrder}**：\n> ${stepContent}\n\n需要我为你提供“提示”或者“概念解释”吗？`,
        currentStep: session.currentStepOrder,
      };
    }

    if (!schemeId)
      return {
        text: "🤔 我没太听懂，你可以问“这一步怎么做”或“给我个提示”。",
        currentStep: session.currentStepOrder,
      };

    if (!session.counters[schemeId]) session.counters[schemeId] = 0;
    session.counters[schemeId]++;
    const count = session.counters[schemeId];
    const [schemes] = await pool.execute(
      "SELECT * FROM inquiry_scheme WHERE schemeId = ?",
      [schemeId]
    );
    if (schemes.length === 0)
      return { text: "配置错误", currentStep: session.currentStepOrder };

    const schemeData = schemes[0];
    const targetStrategyId =
      count <= 1 ? schemeData.strategyId_1 : schemeData.strategyId_2;
    const payload = schemeId === 1 && entity ? entity : message;
    const replyText = await executeStrategy(session, targetStrategyId, payload);

    return { text: replyText, currentStep: session.currentStepOrder };
  } catch (e) {
    console.error(e);
    return { text: "系统繁忙，请稍后再试。", currentStep: 0 };
  }
}

app.post("/api/init", async (req, res) => {
  const { userId, questionId } = req.body;
  const session = getSession(userId);
  session.questionId = questionId || 1;
  session.currentStepOrder = 1;
  session.counters = {};
  try {
    const [probs] = await pool.execute(
      "SELECT title FROM problem WHERE problemId=?",
      [session.questionId]
    );
    const [steps] = await pool.execute(
      "SELECT stepContent FROM problem_step WHERE problemId=? AND stepId=1",
      [session.questionId]
    );
    const systemMsg = `👋 嗨！我是你的智能助教。\n\n📚 **当前任务**：\n> ${probs[0].title}\n\n让我们开始 **Step 1**：\n${steps[0].stepContent}\n\n你可以随时向我求助！`;
    res.json({ systemMsg, currentStep: 1 });
  } catch (e) {
    res.status(500).json({ error: "Init Error" });
  }
});

app.post("/api/chat", async (req, res) => {
  const result = await handleUserMessage(req.body.userId, req.body.message);
  res.json(result);
});

(async () => {
  try {
    await trainModel();
    app.listen(3000, () => console.log("🚀 Server running on port 3000"));
  } catch (e) {
    console.error("启动失败:", e);
  }
})();
