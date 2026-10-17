import React from "react"
import { useTranslation } from "react-i18next"
import pkg from "../../../../package.json"
import { useAppDispatch, useAppSelector } from "../hooks"
import { setErrorAlertMessage } from "../stores/NetworkStore"
import Login from "./component/auth/login"
import PolicyButton from "./component/buttons/policy-button"
import TermsButton from "./component/buttons/terms-button"
import LanguageSelect from "./component/language-select"
import { Modal } from "./component/modal/modal"
import Wiki from "./component/wiki/wiki"
import "./auth.css"

export default function Auth() {
  const { t } = useTranslation()
  const isSupposedlyMobile =
    navigator.maxTouchPoints > 0 &&
    window.matchMedia("(orientation: portrait)").matches
  const [modal, setModal] = React.useState<string | null>(null)
  const dispatch = useAppDispatch()
  const networkError = useAppSelector((state) => state.network.error)

  return (
    <div className="auth-page">
      {isSupposedlyMobile && (
        <p className="mobile-warning">{t("auth.mobile_warning")}</p>
      )}
      <img className="logo" src="assets/ui/pokemon_autochess_final.svg" />
      <header>
        <h1>{t("auth.pokemon_auto_chess")}</h1>
        <div className="disclaimer">
          <p>{t("auth.nintendo_warning")}</p>
        </div>
      </header>
      <main>
        <Login />
      </main>
      <div className="media">
        <PolicyButton />
        <TermsButton />
        <button className="bubbly blue" onClick={() => setModal("wiki")}>
          <img width={32} height={32} src={`assets/ui/wiki.svg`} />
          {t("wiki.title")}
        </button>
        <span>V{pkg.version}</span>
        <div className="language-select">
          <LanguageSelect />
        </div>
        <p>
          {t("auth.made_for_fans")}
          <br />
          {t("auth.non_profit")} / {t("auth.open_source")}
          <br />
          {t("auth.copyright")}
        </p>
      </div>
      <Modal
        onClose={() => setModal(null)}
        show={modal === "wiki"}
        className="wiki-modal"
        header={t("wiki.title")}
      >
        <Wiki inGame={false} />
      </Modal>
      <Modal
        show={networkError != null}
        onClose={() => {
          dispatch(setErrorAlertMessage(null))
        }}
        className="is-dark basic-modal-body"
        body={<p style={{ padding: "1em" }}>{networkError}</p>}
      />
    </div>
  )
}
