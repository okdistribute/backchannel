/** @jsxImportSource @emotion/react */
import React from 'react';
import { Route } from 'wouter';
import { css } from '@emotion/react/macro';

import { color, viewport } from './components/tokens';
import Mailbox from './components/Mailbox';
import ContactList from './components/ContactList';
import Contact from './components/Contact';
import Devices from './components/Devices';
import AddContact from './components/AddContact';
import NetworkError from './components/Error';
import Settings, {
  ClearAllSettings,
  RelaySettings,
} from './components/Settings';

export default function App() {
  return (
    <div
      css={css`
        background: ${color.primary};
        max-width: max(100vh, ${viewport.maxWidth}px);
        max-height: max(100vh, ${viewport.maxHeight}px);
        height: 100%;
        margin: auto;
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
        {(params) => <Devices deviceId={params.did} />}
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
    </div>
  );
}
