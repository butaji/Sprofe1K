require("dotenv").config();

import csvParse from "csv-parse";
import fs from "fs";
import Datastore from "nedb-promises";
import { Telegraf } from "telegraf";

type Word = {
  id: number;
  original: string;
  target: string;
  example: string;
  nextReview: number;
  interval: number;
  easeFactor: number;
  userId: number;
  language: string;
};

type User = {
  id: number;
  language: string;
  progress: Boolean[];
};

const wordsDb: Datastore<Word> = Datastore.create({
  filename: "./wordsDb.json",
  autoload: true,
});
const usersDb: Datastore<User> = Datastore.create({
  filename: "./usersDb.json",
  autoload: true,
});

// Create an object to store the language files
const languageFiles: Record<string, Word[]> = {};

// Read and parse the language files
const languages = ["spanish","german","french","italian","russian"];

for (const language of languages) {
  languageFiles[language] = [];

  fs.createReadStream(`./${language}_frequency_list.csv`)
    .pipe(csvParse.parse({ columns: true }))
    .on("data", (row) => languageFiles[language].push(row));
}

const bot = createBot();

function createBot(): Telegraf {
  if (process.env.BOT_TOKEN) {
    return new Telegraf(process.env.BOT_TOKEN);
  } else {
    throw Error("Error: BOT_TOKEN is not defined");
  }
}

bot.start(async (ctx) => {
  await ctx.reply(
    "Welcome to the language learning bot! Type /help for a list of available commands."
  );

  console.log("Bot started");
});

bot.help((ctx) => {
  ctx.reply(
    "Commands: /language - choose the language you want to learn /review - review words and phrases in a spaced repetition system"
  );

  console.log("Help requested");
});

bot.command("language", async (ctx) => {
  const inlineKeyboard = languages.map((language) => [
    { text: language, callback_data: "language:" + language },
  ]);

  await ctx.reply("Please select the language you want to learn:", {
    reply_markup: {
      inline_keyboard: inlineKeyboard,
    },
  });
});

bot.action(/^[a-z]+$/, async (ctx) => {
  console.log(ctx);
});

bot.action(/^review:.+$/, async (ctx) => {
  if (ctx.from && ctx.callbackQuery) {
    // Get the response from the callback data
    const response = ctx.match[0].substring(7).split(",");

    // Update the database based on the user's response
    const result = await updateWord(
      ctx.from.id,
      Number(response[0]),
      response[1],
      response[2],
      response[3]
    );

    await usersDb.update(
      { id: ctx.from.id },
      { $push: { progress: result } },
      { upsert: true }
    );

    // await ctx.deleteMessage(ctx.callbackQuery.message?.message_id);

    if (result) {
      review(ctx, result);
    } 
  }
});

bot.action(/^language:.+$/, async (ctx) => {
  if (ctx.from && ctx.callbackQuery) {
    // Get the response from the callback data
    const language = ctx.match[0].substring(9);

    await usersDb.update(
      { id: ctx.from.id },
      { $set: { language: language } },
      { upsert: true }
    );

    // Add the language file to the database
    await addFrequencyListToDatabase(
      ctx.from.id,
      language,
      languageFiles[language]
    );

    await ctx.answerCbQuery(`Language set to ${language}`);

    review(ctx, true);
  }
});

bot.command("view", async (ctx) => {
  const ps = ctx.update.message.text.split(" ");
  const id: number = +ps[1];

  const word = await wordsDb.find({ id });

  return await ctx.replyWithHTML(
    `<b>storage version</b>
${JSON.stringify(word, null, 2)}`
  );
});

bot.command("review", async (ctx) => review(ctx, false));

async function review(ctx: any, update: Boolean) {
  const user = await usersDb.findOne({ id: ctx.from.id });

  if (!user) {
    await ctx.reply("Please select a language using the /language command.");
    return;
  }

  const item = await getNextItemForReview(ctx.from.id, user.language);

  if (!item) {
    await ctx.reply("No items available for review at this time.");
    return;
  }

  const incorrectAnswers = await getIncorrectAnswers(item);

  const options = [item.target, ...incorrectAnswers]
    .sort(() => Math.random() - 0.5)
    .map((x) => [x, `review:${item.id},${item.language},${item.target},${x}`]);

  try {
    await ctx.editMessageText(
      `(I-${item.id}) Progress: ${(user.progress ?? [])
        .map((x) => (x ? "✅" : "❌"))
        .slice(-4)}
    
Which of the following is the correct translation for "${item.original}"?`
    );

    await ctx.editMessageReplyMarkup({
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: options[0][0],
              callback_data: options[0][1],
            },
            {
              text: options[1][0],
              callback_data: options[1][1],
            },
          ],
          [
            {
              text: options[2][0],
              callback_data: options[2][1],
            },
            {
              text: options[3][0],
              callback_data: options[3][1],
            },
          ],
        ],
      },
    });
  } catch {
    await ctx.deleteMessage();

    await ctx.reply(
      `(II-${item.id}) Progress: ${(user.progress ?? [])
        .map((x) => (x ? "✅" : "❌"))
        .slice(-4)}
    
Which of the following is the correct translation for "${item.original}"?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: options[0][0],
                callback_data: options[0][1],
              },
              {
                text: options[1][0],
                callback_data: options[1][1],
              },
            ],
            [
              {
                text: options[2][0],
                callback_data: options[2][1],
              },
              {
                text: options[3][0],
                callback_data: options[3][1],
              },
            ],
          ],
        },
      }
    );
  }
}

async function addFrequencyListToDatabase(
  userId: number,
  language: string,
  frequencyList: Word[]
) {
  for (const entry of frequencyList) {
    await wordsDb.update(
      { id: Number(entry.id), userId, language },
      { $set: { original: entry.original, target: entry.target } },
      { upsert: true }
    );
  }
}

async function updateWord(
  userId: number,
  itemId: number,
  language: string,
  word: string,
  response: string
): Promise<Boolean> {
  const item = await wordsDb.findOne({
    id: itemId,
    userId: userId,
    language: language,
  });

  if (!item) {
    throw Error(
      `Word isn't found for ${{
        target: word,
        userId: userId,
        language: language,
      }}`
    );
  }

  console.log(`${response} === ${word}`);

  if (response === word) {
    // Update the word with the correct response

    console.log(Date.now() + item.interval);
    console.log(Math.round(item.interval * item.easeFactor));
    console.log(item.easeFactor + 0.1);

    await wordsDb.update(
      { id: item.id, userId: userId, language: language },
      {
        $set: {
          nextReview: Date.now() + item.interval,
          interval: Math.round(item.interval * item.easeFactor),
          easeFactor: item.easeFactor + 0.1,
        },
      },
      { upsert: true }
    );

    return true;
  } else {
    // Update the word with the incorrect response
    await wordsDb.update(
      { id: item.id, userId: userId, language: language },
      {
        $set: {
          nextReview: Date.now() + item.interval,
          interval: Math.round(item.interval * 1.3),
          easeFactor: Math.max(item.easeFactor - 0.2, 1.3),
        },
      },
      { upsert: true }
    );

    return false;
  }
}

async function getNextItemForReview(userId: number, language: string) {
  const item = await wordsDb
    .findOne({
      userId,
      language,
      $or: [
        { nextReview: { $lte: Date.now() } },
        { nextReview: { $exists: false } },
      ],
    })
    .sort({ id: 1 });

  return item;
}

async function getIncorrectAnswers(word: Word) {
  const words = await wordsDb
    .find({
      userId: word.userId,
      language: word.language,
      original: { $ne: word.original },
    })
    .limit(3);

  if (words.length > 0) {
    return words.map((w) => w.target);
  }

  console.log(
    await wordsDb.find({
      userId: word.userId,
      language: word.language,
    })
  );

  throw Error("No alternatives found");
}

bot.launch();
