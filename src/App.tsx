/** @jsxImportSource @emotion/react */
import React from 'react';
import { Route } from 'wouter';
import { css } from '@emotion/react/macro';
import '@pwabuilder/pwaupdate';

import { color, fontSize, viewport } from './components/tokens';
import Mailbox from './components/Mailbox';
import ContactList from './components/ContactList';
import Contact from './components/Contact';
import Device from './components/Device';
import AddContact from './components/AddContact';
import NetworkError from './components/Error';
import Settings, {
  ClearAllSettings,
  RelaySettings,
} from './components/Settings';

const PwaUpdate = () => {
  //@ts-ignore
  let el = <pwa-update />;
  return (
    <div
      css={css`
        pwa-update::part(updateToast) {
          background: ${color.codeShareBackground};
          color: ${color.codeShareToggleText};
          display: block;
          font-size: ${fontSize[1]}px;
        }

        pwa-update::part(offlineToast) {
          display: none;
        }
      `}
    >
      {el}
    </div>
  );
};

export default function App() {
  return (
    <div
      css={css`
        background: ${color.primary};
        height: 100%;

        @media (min-width: 400px) {
          max-width: 100vw;
          max-height: 100vh;
          height: 100%;
        }

        @media (min-width: 801px) {
          margin: auto;
          max-width: ${viewport.maxWidth}px;
          max-height: min(130vw, ${viewport.maxHeight}px);
        }
      `}
    >
      <Route path="/redeem/:object">
        {(params) => <AddContact view={'redeem'} object={params.object} />}
      </Route>
      <Route path="/generate/:object">
        {(params) => <AddContact view={'generate'} object={params.object} />}
      </Route>
      <Route path="/settings/reset">
        <ClearAllSettings />
      </Route>
      <Route path="/settings/relay">
        <RelaySettings />
      </Route>
      <Route path="/settings">
        <Settings />
      </Route>
      <Route path="/device/:did">
        {(params) => <Device deviceId={params.did} />}
      </Route>
      <Route path="/mailbox/:cid">
        {(params) => <Mailbox contactId={params.cid} />}
      </Route>
      <Route path="/contact/:cid/add">
        {(params) => <Contact contactId={params.cid} />}
      </Route>
      <Route path="/">
        <ContactList />
      </Route>
      <NetworkError />
      <PwaUpdate />
    </div>
  );
}
