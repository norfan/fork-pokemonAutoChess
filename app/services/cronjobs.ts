import { matchMaker } from "colyseus"
import { CronJob } from "cron"
import {
  CRON_ELO_DECAY_DELAY,
  CRON_ELO_DECAY_MINIMUM_ELO,
  CRON_HISTORY_CLEANUP_DELAY,
  ELO_DECAY_LOST_PER_DAY,
  ELO_DECAY_NB_GAMES_REQUIRED,
  EloRankThreshold,
  getCurrentGameEvent
} from "../config"
import DetailledStatistic from "../models/mongo-models/detailled-statistic-v2"
import TitleStatistic from "../models/mongo-models/title-statistic"
import UserMetadata from "../models/mongo-models/user-metadata"
import { Title } from "../types"
import { EloRank } from "../types/enum/EloRank"
import { GameMode } from "../types/enum/Game"
import { GameEvent, GameEvents } from "../types/events"
import { wait } from "../utils/function"
import { logger } from "../utils/logger"
import { min } from "../utils/number"
import { logPreviousDayBoosterCreationStats } from "./booster-monitor"
import { fetchMetaReports } from "./meta"
import { notificationsService } from "./notifications"

export function initCronJobs(isMainThread: boolean) {
  logger.debug("init cron jobs")

  if (isMainThread) {
    // These cron jobs should only be trigged once no matter the amount of processes the server runs on,
    // because they update the same database used by all processes

    // CronJob.from({
    //   cronTime: "0 8 * * *", // every day at 8am
    //   timeZone: "Europe/Paris",
    //   onTick: () => deleteOldAnonymousAccounts(),
    //   start: true
    // })
    CronJob.from({
      cronTime: "15 8 * * *", // every day at 8:15am
      timeZone: "Europe/Paris",
      onTick: () => deleteOldHistory(),
      start: true
    })
    CronJob.from({
      cronTime: "30 8 * * *", // every day at 8:30am
      timeZone: "Europe/Paris",
      onTick: () => eloDecay(),
      start: true
    })
    CronJob.from({
      cronTime: "45 8 * * *", // every day at 8:45am
      timeZone: "Europe/Paris",
      onTick: () => titleStats(),
      start: true
    })
    CronJob.from({
      cronTime: "50 8 * * *", // every day at 8:50am
      timeZone: "Europe/Paris",
      onTick: () => notificationsService.cleanupOldNotifications(),
      start: true
    })
    CronJob.from({
      cronTime: "10 0 * * *", // every day at 00:10 UTC
      timeZone: "UTC",
      onTick: () => logPreviousDayBoosterCreationStats(),
      start: true
    })
    CronJob.from({
      cronTime: "0 0 1 * *", // at midnight UTC on the first day of each month
      timeZone: "UTC",
      onTick: async () => {
        await changeMonthlyEvent()
        await resetEventScores()
      },
      start: true
    })
  }

  // see https://github.com/keldaanCommunity/pokemonAutoChessMetaReport/blob/main/.github/workflows/main.yml
  // Meta report generation task is launched at 1:00 AM UTC, so we expect meta report generation to be done by then (< 1 hour)
  CronJob.from({
    cronTime: "0 2 * * *", // every day at 2:00 AM UTC
    timeZone: "UTC",
    onTick: () => {
      fetchMetaReports()
    },
    start: true
  })
}

async function deleteOldAnonymousAccounts() {
  // Offline build: accounts are local (no Firebase), so there is no third-party
  // identity provider to prune. Kept as a no-op for API compatibility.
  logger.info("[CRON] Skipping anonymous account cleanup (local mode)")
}

async function eloDecay() {
  logger.info("[CRON] Computing elo decay...")
  const users = await UserMetadata.find(
    { elo: { $gt: CRON_ELO_DECAY_MINIMUM_ELO } },
    ["uid", "elo", "displayName"]
  )
  if (users && users.length > 0) {
    logger.info(`Checking activity of ${users.length} users`)
    for (let i = 0; i < users.length; i++) {
      const u = users[i]
      const stats = await DetailledStatistic.find(
        {
          playerId: u.uid,
          ...(u.elo >= EloRankThreshold[EloRank.ULTRA_BALL]
            ? { gameMode: GameMode.RANKED }
            : {})
        },
        ["time"],
        {
          limit: 3,
          sort: { time: -1 }
        }
      )

      const shouldDecay =
        stats.length < ELO_DECAY_NB_GAMES_REQUIRED ||
        Date.now() - stats[2].time > CRON_ELO_DECAY_DELAY

      if (shouldDecay) {
        const eloAfterDecay = min(CRON_ELO_DECAY_MINIMUM_ELO)(
          u.elo - ELO_DECAY_LOST_PER_DAY
        )
        logger.info(
          `User ${u.displayName} (${u.elo}) will decay to ${eloAfterDecay}`
        )
        u.elo = eloAfterDecay
        await u.save()
      }
    }
  } else {
    logger.info("No users to check")
  }
}

async function titleStats() {
  logger.info("[CRON] Recomputing title statistics...")
  const count = await UserMetadata.estimatedDocumentCount()
  logger.info(`${count} users found`)
  for (const title of Object.values(Title)) {
    const titleCount = await UserMetadata.countDocuments({
      titles: title
    })
    await TitleStatistic.deleteMany({ name: title })
    await TitleStatistic.create({ name: title, rarity: titleCount / count })
  }
}

async function deleteOldHistory() {
  logger.info("[CRON] Deleting 4 weeks old games...")
  const deleteResults = await DetailledStatistic.deleteMany({
    time: { $lt: Date.now() - CRON_HISTORY_CLEANUP_DELAY }
  })
  logger.info(`${deleteResults.deletedCount} detailed statistics deleted`)
}

async function changeMonthlyEvent() {
  const monthLastWeek = new Date()
  monthLastWeek.setDate(monthLastWeek.getDate() - 7)
  const previousEvent =
    GameEvents[monthLastWeek.getUTCMonth() % GameEvents.length]

  try {
    logger.info(`[CRON] Cloturing event ${previousEvent}...`)

    if (previousEvent === GameEvent.POKEPALS) {
      // give the title Bestie to the two players of the winning team (that have the highest eventPoints)
      const winners = await awardTitleToTopEventPlayers(Title.BESTIE)
      if (winners.length > 0) {
        // publish an announcement with the names of the players that won the Poképals event
        matchMaker.presence.publish(
          "announcement",
          `Congratulations to ${winners.join(
            " and "
          )} for winning the Poképals contest and earning the Bestie title!`
        )
      }
    } else if (previousEvent === GameEvent.EXPEDITIONS) {
      // give the title Guild Hero to the players with the highest eventPoints
      const winners = await awardTitleToTopEventPlayers(Title.GUILD_HERO)
      if (winners.length > 0) {
        matchMaker.presence.publish(
          "announcement",
          `Congratulations to ${winners.join(
            " and "
          )} for winning the Expeditions season and earning the Guild Hero title!`
        )
      }
    }
  } catch (e) {
    logger.error("Error during cloturing event:", e)
  }
}

async function resetEventScores() {
  try {
    logger.info("[CRON] Starting event scores reset...")

    // Reset event-related fields for all users in a single operation
    const result = await UserMetadata.updateMany(
      {
        $or: [
          { eventPoints: { $gt: 0 } },
          { maxEventPoints: { $gt: 0 } },
          { eventFinishTime: { $exists: true, $ne: null } }
        ]
      },
      {
        $set: {
          eventPoints: 0,
          maxEventPoints: 0,
          eventFinishTime: null,
          eventData: {}
        }
      }
    )

    logger.info(
      `Event reset completed! Reset event data for ${result.modifiedCount} users`
    )

    await wait(60 * 1000) // wait 1 minute to ensure the clock has ticked to the next month for all servers

    const newEvent = getCurrentGameEvent()
    switch (newEvent) {
      case GameEvent.VICTORY_ROAD:
        matchMaker.presence.publish(
          "announcement",
          "Victory Road has started! Be the first to reach the finish line!"
        )
        break
      case GameEvent.EXPEDITIONS:
        matchMaker.presence.publish(
          "announcement",
          "Expeditions season has started! Earn bonus experience points by accomplishing various challenges!"
        )
        break
      case GameEvent.POKEPALS:
        matchMaker.presence.publish(
          "announcement",
          "Poképals contest has started! Team up with your pal and win in Double up mode against other teams!"
        )
        break
    }
  } catch (e) {
    logger.error("Error during event reset scores:", e)
  }
}

async function awardTitleToTopEventPlayers(title: Title): Promise<string[]> {
  const topPlayer = await UserMetadata.findOne(
    { eventPoints: { $gt: 0 } },
    { eventPoints: 1 }
  )
    .sort({ eventPoints: -1 })
    .lean()

  if (!topPlayer) {
    return []
  }

  const topEventPoints = topPlayer.eventPoints
  const winners = await UserMetadata.find(
    { eventPoints: topEventPoints },
    { displayName: 1 }
  ).lean()

  await UserMetadata.updateMany(
    { eventPoints: topEventPoints },
    { $addToSet: { titles: title } }
  )

  return winners.map((winner) => winner.displayName)
}
