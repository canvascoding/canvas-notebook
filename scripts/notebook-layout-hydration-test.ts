import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { NOTEBOOK_LAYOUT_STORAGE_KEY, defaultNotebookLayoutPreferences, readNotebookLayoutPreferences,
  type NotebookLayoutState } from '../app/lib/notebook/layout-state';

type Layout = ReturnType<typeof import('../app/components/notebook/useNotebookLayoutController').useNotebookLayoutController>;
type Scheduling = 'hydration-before-viewport-commit' | 'hydration-after-viewport-commit';
const modules = Module as typeof Module & { _load: (request:string,parent:NodeModule|null,isMain:boolean) => unknown };
const originalLoad = modules._load, originalFetch = globalThis.fetch;
let terminalEnabled = true, unexpectedNetwork = 0;
modules._load = (request,parent,isMain) => {
  if (/\/TerminalAvailabilityProvider(?:\.tsx)?$/u.test(request)) {
    return {useTerminalAvailability:() => ({terminalEnabled,ready:true})};
  }
  return originalLoad(request,parent,isMain);
};
globalThis.fetch = async () => { unexpectedNetwork++; throw new Error('Layout hydration cannot contact a server.'); };

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'https://layout.fixture.invalid/en/notebook'});
  const keys = ['window','document','navigator','HTMLElement','Element','Node','Event','IS_REACT_ACT_ENVIRONMENT'] as const;
  const globals = new Map(keys.map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for (const key of keys) Object.defineProperty(globalThis,key,{configurable:true,
    value:key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window,key)});
  const originalSetTimeout = dom.window.setTimeout, originalClearTimeout = dom.window.clearTimeout;
  const hydrationTimers = new Map<number,() => void>(); let nextTimer = 1;
  dom.window.setTimeout = ((handler:TimerHandler,delay?:number,...args:unknown[]) => {
    assert.equal(delay,0,'Only the actual zero-delay layout hydration timer is controlled.');
    assert.equal(typeof handler,'function');
    const id = nextTimer++; hydrationTimers.set(id,() => Reflect.apply(handler as (...parameters: unknown[]) => void,dom.window,args)); return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = ((id:number) => { hydrationTimers.delete(id); }) as typeof dom.window.clearTimeout;
  const deliverHydration = () => {
    assert.equal(hydrationTimers.size,1,'The actual hook must schedule one hydration callback.');
    const [id,callback] = [...hydrationTimers][0]; hydrationTimers.delete(id); callback();
  };
  let cases = 0; const failures: unknown[] = [];
  try {
    const {useNotebookLayoutController} = await import('../app/components/notebook/useNotebookLayoutController');
    const scenario = async (name:string,width:number,scheduling:Scheduling,open:boolean,
      inspect?:(current:() => Layout) => Promise<void>) => {
      terminalEnabled = !name.includes('disabled terminal');
      Object.defineProperty(dom.window,'innerWidth',{value:width,writable:true,configurable:true});
      dom.window.localStorage.clear();
      dom.window.localStorage.setItem(NOTEBOOK_LAYOUT_STORAGE_KEY,JSON.stringify({...defaultNotebookLayoutPreferences(),explorerOpen:open,terminalOpen:open}));
      const root = createRoot(dom.window.document.getElementById('root')!);
      let latest: Layout | undefined, delivered = false;
      const observed: Array<{width:number;hydrated:boolean;state:NotebookLayoutState}> = [];
      function Probe() {
        const value = useNotebookLayoutController(); latest = value;
        observed.push({width:value.viewportWidth,hydrated:value.preferencesHydrated,state:{...value.state}});
        // The test controls delivery of the existing timer before queued passive
        // viewport updates commit. No hook, reducer, storage or measurement is mocked.
        useEffect(() => {
          if (scheduling === 'hydration-before-viewport-commit' && !delivered) { delivered = true; deliverHydration(); }
        },[]);
        return React.createElement('output',{'data-viewport':value.state.viewport});
      }
      const current = () => { assert(latest); return latest; };
      try {
        await act(async () => { root.render(React.createElement(Probe)); });
        if (scheduling === 'hydration-after-viewport-commit') await act(async () => { deliverHydration(); });
        const value = current(), mobile = width<768;
        console.log('Actual layout hydration observation:',JSON.stringify({name,width,scheduling,
          measuredWidth:value.viewportWidth,viewport:value.state.viewport,explorerOpen:value.state.explorerOpen,
          terminalOpen:value.state.terminalOpen,persisted:readNotebookLayoutPreferences(dom.window.localStorage)}));
        assert.equal(observed[0].width,0,'Exercise the actual hook bootstrap sentinel.');
        assert.equal(value.viewportWidth,width,'Use the genuine measured window width.');
        assert.equal(value.preferencesHydrated,true);
        assert.equal(value.state.explorerOpen,!mobile && open,`${name}: desktop hydration must retain the persisted Explorer preference.`);
        assert.equal(value.state.terminalOpen,!mobile && open && terminalEnabled,`${name}: desktop hydration must retain an allowed Terminal preference.`);
        const persisted = readNotebookLayoutPreferences(dom.window.localStorage);
        assert.equal(persisted.explorerOpen,!mobile && open,`${name}: persistence cannot replace a desktop preference with the zero-width mobile placeholder.`);
        assert.equal(persisted.terminalOpen,!mobile && open && terminalEnabled);
        assert.equal(value.state.viewport,mobile ? 'mobile' : width===1024 ? 'desktop-compact' : 'desktop-wide');
        await inspect?.(current);
        cases++; console.log(`Notebook layout hydration passed: ${name}`);
      } catch (error) { failures.push(error); }
      finally { await act(async () => { root.unmount(); }); assert.equal(hydrationTimers.size,0); }
    };
    for (const scheduling of ['hydration-before-viewport-commit','hydration-after-viewport-commit'] as const) {
      for (const [name,width] of [['wide desktop',1440],['compact desktop',1024],['real mobile',390]] as const) {
        await scenario(`${name} ${scheduling}`,width,scheduling,true);
      }
    }
    await scenario('explicit closed desktop preferences',1440,'hydration-before-viewport-commit',false);
    await scenario('disabled terminal retains Explorer only',1440,'hydration-before-viewport-commit',true);
    await scenario('real resize keeps mobile closed and accepts an explicit later desktop reopen',1440,'hydration-after-viewport-commit',true,async current => {
      await act(async () => { (dom.window as unknown as {innerWidth:number}).innerWidth=390; dom.window.dispatchEvent(new dom.window.Event('resize')); });
      assert.equal(current().state.viewport,'mobile'); assert.equal(current().state.explorerOpen,false); assert.equal(current().state.terminalOpen,false);
      await act(async () => { current().dispatch({type:'SET_EXPLORER',open:true}); current().dispatch({type:'SET_TERMINAL',open:true}); });
      assert.equal(current().state.explorerOpen,false); assert.equal(current().state.terminalOpen,false);
      await act(async () => { (dom.window as unknown as {innerWidth:number}).innerWidth=1440; dom.window.dispatchEvent(new dom.window.Event('resize')); });
      assert.equal(current().state.viewport,'desktop-wide'); assert.equal(current().state.explorerOpen,false); assert.equal(current().state.terminalOpen,false);
      await act(async () => { current().dispatch({type:'SET_EXPLORER',open:true}); current().dispatch({type:'SET_TERMINAL',open:true}); });
      assert.equal(current().state.explorerOpen,true); assert.equal(current().state.terminalOpen,true);
      assert.equal(readNotebookLayoutPreferences(dom.window.localStorage).explorerOpen,true);
    });
    assert.equal(unexpectedNetwork,0);
    if (failures.length) throw new AggregateError(failures,`${failures.length} actual layout hydration scenarios failed (${cases} passed).`);
    assert.equal(cases,9);
  } finally {
    dom.window.setTimeout=originalSetTimeout; dom.window.clearTimeout=originalClearTimeout;
    dom.window.close(); modules._load=originalLoad; globalThis.fetch=originalFetch;
    for (const key of keys) {
      const descriptor=globals.get(key); if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key);
    }
  }
  console.log(`notebook-layout-hydration-test: ${cases} actual hook/reducer/storage scenarios passed after cleanup.`);
}

void main().catch(error => { modules._load=originalLoad; globalThis.fetch=originalFetch; console.error(error); process.exitCode=1; });
