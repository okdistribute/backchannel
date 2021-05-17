/** @jsxImportSource @emotion/react */
import React, { useEffect, useState } from 'react';
import { css } from '@emotion/react/macro';
import { Link, Route, useLocation } from 'wouter';

import { copyToClipboard } from './web';
import { Code, ContactId } from './backend/types';
import { TopBar, A, Button } from './components';
import Mailbox from './components/Mailbox';
import ContactList from './components/ContactList';
import Backchannel from './backend';
import { ERROR } from './backend/backchannel';

let backchannel = Backchannel();

// Amount of time to show immediate user feedback
let USER_FEEDBACK_TIMER = 5000;

type CodeViewMode = 'add' | 'generate';

const CodeView = ({ view }: { view: CodeViewMode }) => {
  let [code, setCode] = useState<Code>('');
  let [message, setMessage] = useState('');
  let [errorMsg, setErrorMsg] = useState('');
  //eslint-disable-next-line
  let [_, setLocation] = useLocation();

  useEffect(() => {
    // get code on initial page load
    if (!code) {
      onClickGenerate();
    }
  });

  // Set user feedback message to disappear if necessary
  useEffect(() => {
    if (message) {
      const timeout = setTimeout(() => {
        setMessage('');
      }, USER_FEEDBACK_TIMER);

      return () => clearTimeout(timeout);
    }
  }, [message]);

  let onError = (err: Error) => {
    console.error('got error from backend', err);
    setErrorMsg(err.message);
  };

  function handleChange(event) {
    setErrorMsg('');
    setCode(event.target.value);
  }

  async function onClickRedeem() {
    console.log('on click redeem', code);
    try {
      let cid: ContactId = await backchannel.accept(code);
      console.log('opening mailbox', cid);
      setErrorMsg('');
      setLocation(`/mailbox/${cid}`);
    } catch (err) {
      onError(err);
    }
  }

  async function onClickGenerate() {
    setErrorMsg('');

    try {
      const code: Code = await backchannel.getCode();

      if (code) {
        setCode(code);

        // This promise returns once the other party redeems the code
        let cid: ContactId = await backchannel.announce(code);
        setLocation(`/mailbox/${cid}`);
      }
    } catch (err) {
      onError(err);
    }
  }

  async function onClickCopy() {
    const copySuccess = await copyToClipboard(code);
    if (copySuccess) {
      setMessage('Code copied!');
    }
  }

  return (
    <div>
      <TopBar>
        {view === 'add' && (
          <React.Fragment>
            <input
              css={css`
                font-size: inherit;
                width: 10em;
              `}
              type="text"
              onChange={handleChange}
            ></input>
            <Button onClick={onClickRedeem}>Redeem</Button>
          </React.Fragment>
        )}
        {view === 'generate' && (
          <React.Fragment>
            <input
              css={css`
                font-size: inherit;
                width: 10em;
              `}
              value={code}
              readOnly
            />
            <Button onClick={onClickCopy}>Copy</Button>
          </React.Fragment>
        )}
        <Link
          href="/"
          css={css`
            color: white;
            padding-left: 8px;
            font-size: 0.8em;
          `}
        >
          Cancel
        </Link>
      </TopBar>
      <div>{errorMsg}</div>
      {message && (
        <div
          css={css`
            display: inline-block;
            margin: 16px 0;
            word-break: break-word;
          `}
        >
          {message}
        </div>
      )}
    </div>
  );
};

export default function App() {
  let [relayError, setRelayError] = useState(null);
  let [retries, setRetries] = useState(0);
  function clearDb() {
    backchannel
      .destroy()
      .then(() => {
        console.log('cleared database! refresh.');
      })
      .catch((err) => {
        console.error('error clearing db', err);
      });
  }

  useEffect(() => {
    function onError (err, code: ERROR) {
      switch (code) {
        case ERROR.UNREACHABLE:
          let ms = err.delay % 1000;
          let s = (err.delay - ms) / 1000;
          var secs = s % 60;
          let rest = 'Retrying...'
          if (secs > 1) rest = `Retrying in ${secs} seconds. (${retries} attempts)`
          let message = `${err.message}. ${rest}`
          setRelayError(message)
          setRetries(retries+1)
          break;
        case ERROR.PEER:
          // TODO: do something
          break;
        default:
          break
      }
      console.error(err)
    };

    function onServerConnect() {
      console.log('on server connect!')
      if (relayError) {
        setRelayError(null)
        setRetries(0)
      }
    }

    backchannel.on('error', onError)
    backchannel.on('server.connect', onServerConnect)

    return () => {
      backchannel.removeListener('error', onError)
      backchannel.removeListener('server.connect', onServerConnect)
    }
  });

  return (
    <div
      css={css`
        text-align: center;
      `}
    >
      <Route path="/add">
        <CodeView view={'add'} />
      </Route>
      <Route path="/generate">
        <CodeView view={'generate'} />
      </Route>
      <Route path="/mailbox/:cid">
        {(params) => <Mailbox contactId={params.cid} />}
      </Route>
      <Route path="/">
        <TopBar>
          <A href="add">Input code</A>
          <A href="generate">Generate code</A>
          <A href="">Contacts</A>
        </TopBar>
        <ContactList />
        <Button onClick={clearDb}>ClearDB</Button>
        {relayError && <div>{relayError}</div>}
      </Route>
    </div>
  );
}
