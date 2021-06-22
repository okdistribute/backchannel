/** @jsxImportSource @emotion/react */
import React, { useState } from 'react';
import { Link } from 'wouter';

import config from '../backend/config';
import {
  Button,
  Instructions,
  TopBar,
  UnderlineInput,
  SettingsContent,
  IconButton,
} from '.';
import * as storage from './storage';
import { Page, ContentWithTopNav } from './';
import Backchannel from '../backend';
import { ReactComponent as PlusSmall } from '../components/icons/PlusSmall.svg';
import { ReactComponent as EnvelopeSmall } from '../components/icons/EnvelopeSmall.svg';
import { ReactComponent as CloudCrossedSmall } from '../components/icons/CloudCrossedSmall.svg';
import { ReactComponent as ExportSmall } from '../components/icons/ExportSmall.svg';

let backchannel = Backchannel();

export default function Settings() {
  return (
    <Page align="center">
      <TopBar title="Settings" />
      <ContentWithTopNav>
        <SettingsContent>
          <Link href="/settings/devices">
            <Button>Syncronize Devices</Button>
          </Link>
          <Link href="/settings/relay">
            <Button>Relay URL</Button>
          </Link>
          <Link href="/settings/reset">
            <Button variant="destructive">Clear all Data</Button>
          </Link>
          <Button disabled variant="transparent">
            Export message history
          </Button>
        </SettingsContent>
      </ContentWithTopNav>
    </Page>
  );
}

export function RelaySettings() {
  let [settings, setSettings] = useState(backchannel.settings);

  function updateValues(e) {
    let name = e.target.name;
    let val = e.target.value;
    setSettings({ [name]: val });
  }

  function updateSettings(e) {
    e.preventDefault();
    console.log(e);
    let old = backchannel.settings;
    backchannel
      .updateSettings({ ...old, ...settings })
      .then((_) => {
        console.log('SUCCESS');
      })
      .catch((err) => {
        backchannel.updateSettings(old);
        console.error();
      });
  }

  function restoreDefault(e) {
    e.preventDefault();
    backchannel.updateSettings(config);
  }

  return (
    <Page align="center">
      <TopBar title="Relay URL" backHref="/settings" />
      <ContentWithTopNav>
        <Instructions>
          This is Backchannel relay URL, you can also specify your own:
        </Instructions>
        <SettingsContent>
          <UnderlineInput
            name="relay"
            onChange={updateValues}
            defaultValue={settings.relay}
            placeholder="https://relay.yourdomain.org"
          />
          <Button type="submit" onClick={updateSettings}>
            Save
          </Button>
          <Button variant="transparent" type="submit" onClick={restoreDefault}>
            Restore Default
          </Button>
        </SettingsContent>
      </ContentWithTopNav>
    </Page>
  );
}

export function ClearAllSettings() {
  function clearDb() {
    // clean local storage state
    for (let key in storage.keys) {
      storage.remove(key);
    }

    backchannel.destroy().catch((err) => {
      console.error('error clearing db', err);
    });
  }

  return (
    <Page align="center">
      <TopBar title="Clear all data" backHref="/settings" />
      <ContentWithTopNav>
        <Instructions>
          This will desynchronise all devices. You will have to re-sync all your
          devices manually, and will lose all your messages. Are you happy to
          proceed?
        </Instructions>
        <SettingsContent>
          <Button onClick={clearDb} variant="destructive">
            Yes, clear all data
          </Button>
          <Button disabled variant="transparent">
            Export message history
          </Button>
        </SettingsContent>
      </ContentWithTopNav>
    </Page>
  );
}

export function DevicesSettings() {
  return (
    <Page align="center">
      <TopBar title="Synchronise devices" />
      <ContentWithTopNav>
        <SettingsContent>
          <Link href="/devices/generate">
            <IconButton icon={PlusSmall}>Create sync code</IconButton>
          </Link>
          <Link href="/devices/redeem">
            <IconButton icon={EnvelopeSmall}>Use sync code</IconButton>
          </Link>
          <Link href="/settings/unlink">
            <IconButton
              variant="destructive"
              disabled={backchannel.devices.length < 1}
              icon={CloudCrossedSmall}
            >
              Unlink Devices ({backchannel.devices.length})
            </IconButton>
          </Link>
          <IconButton disabled variant="transparent" icon={ExportSmall}>
            Export message history
          </IconButton>
        </SettingsContent>
      </ContentWithTopNav>
    </Page>
  );
}
