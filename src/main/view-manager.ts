import { ipcMain } from 'electron';
import { VIEW_Y_OFFSET } from '~/constants/design';
import { View } from './view';
import { AppWindow } from './windows';
import { WEBUI_BASE_URL } from '~/constants/files';
import {
  ZOOM_FACTOR_MIN,
  ZOOM_FACTOR_MAX,
  ZOOM_FACTOR_INCREMENT,
} from '~/constants/web-contents';
import { extensions } from 'electron-extensions-suit';
import { EventEmitter } from 'events';
import { Application } from './application';

export class ViewManager extends EventEmitter {
  public views = new Map<number, View>();
  public selectedId = 0;
  // currently in the process of fixing fullscreen as it dosent work at all
  public _fullscreen = false;

  public incognito: boolean;

  private window: AppWindow;
  webContentsView: any;

  public get fullscreen() {
    return this._fullscreen;
  }

  public set fullscreen(val: boolean) {
    this._fullscreen = val;
    this.fixBounds();
  }

  public constructor(window: AppWindow, incognito: boolean) {
    super();

    this.window = window;
    this.incognito = incognito;

    const { id } = window.win;
    ipcMain.handle(`view-create-${id}`, (e, details) => {
      return this.create(details, false, false).id;
    });

    ipcMain.handle(`views-create-${id}`, (e, options) => {
      return options.map((option: any) => {
        return this.create(option, false, false).id;
      });
    });

    ipcMain.on(`add-tab-${id}`, (e, details) => {
      this.create(details);
    });

    ipcMain.on('Print', (e, details) => {
      this.views.get(this.selectedId).webContents.print();
    });

    ipcMain.handle(`view-select-${id}`, (e, id: number, focus: boolean) => {
      if (process.env.ENABLE_EXTENSIONS) {
        extensions.tabs.activate(id, focus);
      } else {
        this.select(id, focus);
      }
    });

    ipcMain.on(`view-destroy-${id}`, (e, id: number) => {
      this.destroy(id);
    });

    ipcMain.on(`mute-view-${id}`, (e, tabId: number) => {
      const view = this.views.get(tabId);
      view.webContents.setAudioMuted(true);
    });

    ipcMain.on(`unmute-view-${id}`, (e, tabId: number) => {
      const view = this.views.get(tabId);
      view.webContents.setAudioMuted(false);
    });

    ipcMain.on(`web-contents-view-clear-${id}`, () => {
      this.clear();
    });

    ipcMain.on('change-zoom', (e, zoomDirection) => {
      this.changeZoom(zoomDirection, e);
    });

    ipcMain.on('reset-zoom', (e) => {
      this.resetZoom();
    });

    this.setBoundsListener();
  }

  public resetZoom() {
    this.selected.webContents.zoomFactor = 1;
    this.selected.emitEvent(
      'zoom-updated',
      this.selected.webContents.zoomFactor,
    );
    this.emitZoomUpdate();
  }

  public changeZoom(zoomDirection: 'in' | 'out', e?: any) {
    const newZoomFactor =
        this.selected.webContents.zoomFactor +
        (zoomDirection === 'in'
          ? ZOOM_FACTOR_INCREMENT
          : -ZOOM_FACTOR_INCREMENT);

      if (
        newZoomFactor <= ZOOM_FACTOR_MAX &&
        newZoomFactor >= ZOOM_FACTOR_MIN
      ) {
        this.selected.webContents.zoomFactor = newZoomFactor;
        this.selected.emitEvent(
          'zoom-updated',
          this.selected.webContents.zoomFactor,
        );
      } else {
        e?.preventDefault();
      }
      this.emitZoomUpdate();
  }

  public get selected() {
    return this.views.get(this.selectedId);
  }

  public get settingsView() {
    return Object.values(this.views).find((r) =>
      r.url.startsWith(`${WEBUI_BASE_URL}settings`),
    );
  }

  public create(
    details: chrome.tabs.CreateProperties,
    isNext = false,
    sendMessage = true,
  ) {
    const view = new View(this.window, details.url, this.incognito);

    const { webContents } = view.webContentsView;
    const { id } = view;

    this.views.set(id, view);

    if (process.env.ENABLE_EXTENSIONS) {
      extensions.tabs.observe(webContents);
    }

    webContents.once('destroyed', () => {
      this.views.delete(id);
    });

    if (sendMessage) {
      this.window.send('create-tab', { ...details }, isNext, id);
    }
    return view;
  }

  public clear() {
    if (this.window && typeof this.window.isDestroyed === 'function' && !this.window.isDestroyed()) {
      if (this.window.contentView && this.window.webContentsView) {
        this.window.contentView.removeChildView(this.window.webContentsView);
      }
      Object.values(this.views).forEach((view) => {
        if (view && view.webContents && !view.webContents.isDestroyed()) {
          view.webContents.destroy();
        }
        console.log('Clearing all views in the ViewManager');
      });
    }
  }  

  public select(id: number, focus = true) {
    const { selected } = this;
    const view = this.views.get(id);

    if (!view) {
      return;
    }

    this.selectedId = id;

    if (selected) {
      this.window.win.contentView.removeChildView(selected.webContentsView);
    }
    
    this.window.win.contentView.addChildView(view.webContentsView);

    if (focus) {
      // Also fixes switching tabs with Ctrl + Tab
      view.webContents.focus();
    } else {
      this.window.webContents.focus();
    }

    this.window.updateTitle();
    view.updateBookmark();

    this.fixBounds();

    view.updateNavigationState();

    this.emit('activated', id);

    // TODO: this.emitZoomUpdate(false);
  }

  public async fixBounds() {
    const view = this.selected;

    if (!view) return;

    const { width, height } = this.window.win.getContentBounds();

    const toolbarContentHeight = await this.window.win.webContents
      .executeJavaScript(`
      document.getElementById('app').offsetHeight
    `);

    const newBounds = {
      x: 0,
      y: this.fullscreen ? 0 : toolbarContentHeight,
      width,
      height: this.fullscreen ? height : height - toolbarContentHeight,
    };

    if (newBounds !== view.bounds) {
      view.webContentsView.setBounds(newBounds);
      view.bounds = newBounds;
    }
  }

  private setBoundsListener() {
    // resize the WebContentsView's height when the toolbar height changes
    // ex: when the bookmarks bar appears
    this.window.webContents.executeJavaScript(`
        const {ipcRenderer} = require('electron');
        const resizeObserver = new ResizeObserver(([{ contentRect }]) => {
          ipcRenderer.send('resize-height');
        });
        const app = document.getElementById('app');
        resizeObserver.observe(app);
      `);

    this.window.webContents.on('ipc-message', (e, message) => {
      if (message === 'resize-height') {
        this.fixBounds();
      }
    });
  }

  public destroy(viewId: number) {
    const view = this.views.get(viewId);
    if (!view || view.isDestroyed) return;
  
    view.isDestroyed = true;
  
    if (this.selectedId === viewId) {
      this.window.win.contentView.removeChildView(view.webContentsView);
  
      if (view.webContentsView && !view.webContentsView.webContents.isDestroyed()) {
        view.webContentsView.webContents.close();
      }
  
      this.selectedId = 0;
    }
  
    if (view.webContentsView && !view.webContentsView.webContents.isDestroyed()) {
      (view.webContentsView.webContents as any).destroy();
    }
  
    if (typeof view.destroy === 'function') {
      view.destroy();
    }
    
    this.views.delete(viewId);
  
    this.emit('removed', viewId);
  }  
  
  public emitZoomUpdate(showDialog = true) {
    Application.instance.dialogs
      .getDynamic('zoom')
      ?.webContentsView?.webContents?.send(
        'zoom-factor-updated',
        this.selected.webContents.zoomFactor,
      );

    this.window.webContents.send(
      'zoom-factor-updated',
      this.selected.webContents.zoomFactor,
      showDialog,
    );
  }
}