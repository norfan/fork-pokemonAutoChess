import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"
import { throttle } from "../../../../../utils/function"
import { joinLobbyRoom } from "../../../game/lobby-logic"
import { useAppDispatch, useAppSelector } from "../../../hooks"
import { getLocalUser, signInLocal, signOutLocal } from "../../../local-auth"
import { logIn, logOut } from "../../../stores/NetworkStore"
import "./login.css"

/**
 * Offline login: no Firebase, no password, no network.
 * The player just picks a nickname, which is persisted locally and used as
 * identity for the local server.
 */
export default function Login() {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const uid = useAppSelector((state) => state.network.uid)
  const displayName = useAppSelector((state) => state.network.displayName)
  const [nickname, setNickname] = useState("")
  const [prejoining, setPrejoining] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  // pick up an existing local identity on first render
  useEffect(() => {
    const stored = getLocalUser()
    if (stored && !uid) {
      dispatch(logIn(stored))
      setNickname(stored.displayName)
    }
  }, [dispatch, uid])

  const preJoinLobby = throttle(async function prejoin() {
    setPrejoining(true)
    return joinLobbyRoom(dispatch, navigate)
      .then(() => navigate("/lobby"))
      .catch(() => setPrejoining(false))
  }, 1000)

  const handleSignIn = (event: React.FormEvent) => {
    event.preventDefault()
    const user = signInLocal(nickname)
    dispatch(logIn(user))
  }

  if (!uid) {
    return (
      <div id="play-panel">
        <form className="offline-login" onSubmit={handleSignIn}>
          <label htmlFor="nickname">Nickname / 昵称</label>
          <input
            id="nickname"
            name="nickname"
            type="text"
            autoComplete="off"
            maxLength={20}
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="Trainer"
          />
          <button className="bubbly blue" type="submit">
            {t("auth.join_lobby")}
          </button>
          <p className="offline-hint">
            Offline mode — no account needed. / 离线模式，无需账号。
          </p>
        </form>
      </div>
    )
  }

  return (
    <div id="play-panel">
      <p>
        {t("auth.authenticated_as")}: <span title={displayName}>{displayName}</span>
      </p>
      <ul className="actions">
        <li>
          <button
            className="bubbly green"
            onClick={preJoinLobby}
            disabled={prejoining}
          >
            {prejoining ? t("auth.connecting") : t("auth.join_lobby")}
          </button>
        </li>
        <li>
          <button
            className="bubbly red"
            disabled={prejoining || loggingOut}
            onClick={async () => {
              setLoggingOut(true)
              try {
                signOutLocal()
                dispatch(logOut())
              } finally {
                setLoggingOut(false)
              }
            }}
          >
            {loggingOut ? t("auth.signing_out") : t("auth.sign_out")}
          </button>
        </li>
      </ul>
    </div>
  )
}
