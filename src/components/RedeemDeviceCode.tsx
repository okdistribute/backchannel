/** @jsxImportSource @emotion/react */
import React, { useEffect, useState, useCallback } from 'react';
import { css } from '@emotion/react/macro';
import { useLocation } from 'wouter';

import { UnderlineInput, Toggle, ToggleWrapper, IconButton } from '.';
import { AnimationMode } from './CodeView';
import DeviceCodeView, { DeviceCodeLoading } from './DeviceCodeView';
import { Key, ContactId } from '../backend/types';
import QRReader from './QRReader';
import { ReactComponent as CloudCycleSmall } from './icons/CloudCycleSmall.svg';
import Backchannel from '../backend';
import { color } from './tokens';

let backchannel = Backchannel();

enum Tab {
  INPUT,
  SCAN,
}

export default function RedeemDeviceCode() {
  let [code, setCode] = useState('');
  const [animationMode, setAnimationMode] = useState(AnimationMode.None);

  let [tab, setTab] = useState<Tab>(Tab.SCAN);
  let [errorMsg, setErrorMsg] = useState('');

  //eslint-disable-next-line
  let [location, setLocation] = useLocation();

  let redeemCode = useCallback(
    async (code) => {
      const onError = (err: Error) => {
        console.error(err);
        setAnimationMode(AnimationMode.Connecting);
        setErrorMsg(err.message);
      };

      if (animationMode === AnimationMode.Connecting) return;
      try {
        setAnimationMode(AnimationMode.Connecting);
        let key: Key = await backchannel.accept(code);

        let deviceId: ContactId = await backchannel.addDevice(key);
        setErrorMsg('');
        setLocation(`/device/${deviceId}`);
      } catch (err) {
        console.log('got error', err);
        onError(err);
        setCode('');
      }
    },
    [animationMode, setLocation, setAnimationMode]
  );

  // attempt to redeem code if it's in the url hash
  useEffect(() => {
    let maybeCode = window.location.hash;
    if (maybeCode.length > 1 && code !== maybeCode) {
      redeemCode(maybeCode.slice(1));
    }
  }, [code, redeemCode]);

  function handleToggleClick(tab: Tab) {
    return () => {
      setTab(tab);
    };
  }

  function handleScanQRCode(value) {
    window.location.href = value;
  }

  function handleInputChange(event) {
    setErrorMsg('');
    setCode(event.target.value);
  }

  async function handleClickRedeem(e) {
    e.preventDefault();
    await redeemCode(code);
  }

  if (animationMode === AnimationMode.Connecting) {
    return <DeviceCodeLoading />;
  }

  return (
    <DeviceCodeView
      header={
        <ToggleWrapper
          css={css`
            background: ${color.deviceLinkToggleBackground};
          `}
        >
          <Toggle
            onClick={handleToggleClick(Tab.INPUT)}
            isActive={tab === Tab.INPUT}
          >
            Enter Invite
          </Toggle>
          <Toggle
            onClick={handleToggleClick(Tab.SCAN)}
            isActive={tab === Tab.SCAN}
          >
            Scan Invite
          </Toggle>
        </ToggleWrapper>
      }
      instructions="Enter the temporary code you created on the other device:"
      content={
        tab === Tab.SCAN ? (
          <QRReader onFind={handleScanQRCode} />
        ) : (
          <form id="code-input">
            <UnderlineInput
              value={code}
              css={css`
                font-size: inherit;
                width: 100%;
                text-align: center;
              `}
              placeholder="Enter the code"
              onChange={handleInputChange}
              autoFocus
            />
          </form>
        )
      }
      message={errorMsg}
      footer={
        tab !== Tab.SCAN && (
          <IconButton
            onClick={handleClickRedeem}
            icon={CloudCycleSmall}
            form="code-input"
            type="submit"
            disabled={code.length === 0}
          >
            Synchronise devices
          </IconButton>
        )
      }
    />
  );
}
