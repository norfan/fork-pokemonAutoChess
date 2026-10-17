import { useTranslation } from "react-i18next"
import { Role, type Title } from "../../../../../types"
import type { Pkm } from "../../../../../types/enum/Pokemon"
import PokemonPortrait from "../pokemon-portrait"
import { RoleBadge } from "./role-badge"

export function InlineAvatar(props: {
  avatar: string
  name: string
  author?: string
  title?: Title | ""
  role?: Role
  twitchLogin?: string
  twitchDisplayName?: string
}) {
  const { t } = useTranslation()
  return (
    <div
      className="inline-avatar"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "start",
        gap: "0.25em",
        flexWrap: "nowrap"
      }}
    >
      <PokemonPortrait
        avatar={props.avatar}
        style={{ width: "40px", height: "40px" }}
      />
      {props.title && (
        <span className="player-title">{t(`title.${props.title}`)}</span>
      )}
      <span className="player-name">
        {props.role === Role.BOT ? t(`pkm.${props.name as Pkm}`) : props.name}
        {props.author && (
          <span className="player-author">
            {" "}
            {t("by")} {props.author}
          </span>
        )}
      </span>
      {props.role && <RoleBadge role={props.role} />}
    </div>
  )
}
