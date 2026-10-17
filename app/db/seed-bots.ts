/**
 * Imports the bundled bot roster (db-commands/botv2.json, MongoDB export
 * format) into the local SQLite database so that offline games have opponents.
 *
 * Usage: npm run seed
 */
import fs from "node:fs"
import path from "node:path"
import { BotV2 } from "../models/mongo-models/bot-v2"
import { connectDB } from "./mongoose-shim"

function reviveExtendedJson(value: any): any {
  if (Array.isArray(value)) return value.map(reviveExtendedJson)
  if (value && typeof value === "object") {
    if (typeof value.$oid === "string") return value.$oid
    if (value.$date !== undefined)
      return new Date(
        typeof value.$date === "number" ? value.$date : value.$date.$numberLong
      )
    const out: Record<string, any> = {}
    for (const [key, entry] of Object.entries(value))
      out[key] = reviveExtendedJson(entry)
    return out
  }
  return value
}

async function main() {
  const source = path.resolve(
    process.argv[2] ?? path.join(process.cwd(), "db-commands", "botv2.json")
  )
  if (!fs.existsSync(source)) {
    console.error(`Bot file not found: ${source}`)
    process.exit(1)
  }

  connectDB()

  const existing = await BotV2.countDocuments({})
  if (existing > 0 && !process.argv.includes("--force")) {
    console.log(`botv2 already contains ${existing} bots — nothing to do.`)
    console.log("Use --force to import again (duplicates are skipped by id).")
    return
  }

  console.log(`Reading ${source} ...`)
  const raw = JSON.parse(fs.readFileSync(source, "utf8")) as any[]
  const bots = raw.map(reviveExtendedJson)
  console.log(`Importing ${bots.length} bots ...`)

  let imported = 0
  for (const bot of bots) {
    const already = await BotV2.findOne({ id: bot.id }).lean()
    if (already) continue
    await BotV2.create(bot)
    imported++
    if (imported % 100 === 0) console.log(`  ${imported} ...`)
  }

  console.log(`Done: ${imported} bots imported, ${bots.length - imported} skipped.`)
}

main().catch((error) => {
  console.error("Bot import failed", error)
  process.exit(1)
})
