import { t } from "i18next"
import { useEffect, useState } from "react"
import { Tab, TabList, TabPanel, Tabs } from "react-tabs"
import { getCurrentGameEvent } from "../../../../../config"
import type { TournamentSchema } from "../../../../../models/colyseus-models/tournament"
import { GameEvent } from "../../../../../types/events"
import { useAppSelector } from "../../../hooks"
import { Announcements } from "./announcements"
import { Expeditions } from "./expeditions"
import { Pokepals } from "./pokepals"
import { TournamentsList } from "./tournaments-list"
import { VictoryRoad } from "./victory-road"

export function EventsMenu() {
  const user = useAppSelector((state) => state.network.profile)
  const tournaments: TournamentSchema[] = useAppSelector(
    (state) => state.lobby.tournaments
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const currentGameEvent = getCurrentGameEvent()

  const hasTournamentTab = tournaments.length > 0
  const tabCount = 2 + (hasTournamentTab ? 1 : 0)

  useEffect(() => {
    if (selectedIndex >= tabCount) {
      setSelectedIndex(Math.max(0, tabCount - 1))
    }
  }, [selectedIndex, tabCount])

  return (
    <Tabs
      className="my-container events-menu custom-bg hidden-scrollable"
      onSelect={(index) => setSelectedIndex(index)}
      selectedIndex={selectedIndex}
    >
      <h2>{t("events")}</h2>
      <TabList>
        <Tab>
          <span>{t("announcements")}</span>
        </Tab>
        {tournaments.length > 0 && (
          <Tab>
            <span>{t("game_modes.TOURNAMENT")}</span>
          </Tab>
        )}
        {currentGameEvent === GameEvent.EXPEDITIONS && (
          <Tab>
            <span>{t("expeditions.title")}</span>
          </Tab>
        )}
        {currentGameEvent === GameEvent.VICTORY_ROAD && (
          <Tab>
            <span>{t("victory_road.title")}</span>
          </Tab>
        )}
        {currentGameEvent === GameEvent.POKEPALS && (
          <Tab>
            <span>{t("pokepals.title")}</span>
          </Tab>
        )}
      </TabList>
      <TabPanel>
        <Announcements />
      </TabPanel>
      {tournaments.length > 0 && (
        <TabPanel>
          <TournamentsList />
        </TabPanel>
      )}
      {currentGameEvent === GameEvent.EXPEDITIONS && (
        <TabPanel>
          <Expeditions />
        </TabPanel>
      )}
      {currentGameEvent === GameEvent.VICTORY_ROAD && (
        <TabPanel>
          <VictoryRoad />
        </TabPanel>
      )}
      {currentGameEvent === GameEvent.POKEPALS && (
        <TabPanel>
          <Pokepals />
        </TabPanel>
      )}
      {!user && <p className="subtitle">{t("loading")}</p>}
    </Tabs>
  )
}
