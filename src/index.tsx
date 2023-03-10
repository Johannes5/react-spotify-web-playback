/* eslint-disable camelcase */
import { createRef, PureComponent, ReactNode } from 'react';
import isEqual from '@gilbarbara/deep-equal';
import memoize from 'memoize-one';

import { getLocale, getMergedStyles, getSpotifyURIType } from '~/modules/getters';
import { loadSpotifyPlayer, parseVolume, round, validateURI } from '~/modules/helpers';
import {
  getDevices,
  getPlaybackState,
  next,
  pause,
  play,
  previous,
  seek,
  setDevice,
  setVolume,
} from '~/modules/spotify';

import Actions from '~/components/Actions';
import Controls from '~/components/Controls';
import Devices from '~/components/Devices';
import ErrorMessage from '~/components/ErrorMessage';
import Info from '~/components/Info';
import Loader from '~/components/Loader';
import Player from '~/components/Player';
import Volume from '~/components/Volume';
import Wrapper from '~/components/Wrapper';

import { STATUS, TYPE } from '~/constants';

import {
  CallbackState,
  Locale,
  PlayOptions,
  Props,
  SpotifyDevice,
  SpotifyPlayerCallback,
  SpotifyPlayerStatus,
  State,
  Status,
  StylesOptions,
} from './types';

import { Spotify } from '../global';

class SpotifyWebPlayer extends PureComponent<Props, State> {
  private isActive = false;
  private emptyTrack = {
    artists: [] as Spotify.Artist[],
    durationMs: 0,
    id: '',
    image: '',
    name: '',
    thumb: '',
    uri: '',
  };

  private hasNewToken = false;
  private locale: Locale;
  private player?: Spotify.Player;
  private playerProgressInterval?: number;
  private playerSyncInterval?: number;
  private ref = createRef<HTMLDivElement>();
  private renderInlineActions = false;
  private resizeTimeout?: number;
  private seekUpdateInterval = 100;
  private styles: StylesOptions;
  private syncTimeout?: number;

  // eslint-disable-next-line unicorn/consistent-function-scoping
  private getPlayOptions = memoize((data): PlayOptions => {
    const playOptions: PlayOptions = {
      context_uri: undefined,
      uris: undefined,
    };

    /* istanbul ignore else */
    if (data) {
      const ids = Array.isArray(data) ? data : [data];

      if (!ids.every(d => validateURI(d))) {
        // eslint-disable-next-line no-console
        console.error('Invalid URI');

        return playOptions;
      }

      if (ids.some(d => getSpotifyURIType(d) === 'track')) {
        if (!ids.every(d => getSpotifyURIType(d) === 'track')) {
          // eslint-disable-next-line no-console
          console.warn("You can't mix tracks URIs with other types");
        }

        playOptions.uris = ids.filter(d => validateURI(d) && getSpotifyURIType(d) === 'track');
      } else {
        if (ids.length > 1) {
          // eslint-disable-next-line no-console
          console.warn("Albums, Artists, Playlists and Podcasts can't have multiple URIs");
        }

        // eslint-disable-next-line prefer-destructuring
        playOptions.context_uri = ids[0];
      }
    }

    return playOptions;
  });

  constructor(props: Props) {
    super(props);

    this.state = {
      currentDeviceId: '',
      deviceId: '',
      devices: [],
      error: '',
      errorType: null,
      isActive: false,
      isInitializing: false,
      isMagnified: false,
      isPlaying: false,
      isSaved: false,
      isUnsupported: false,
      needsUpdate: false,
      nextTracks: [],
      playerPosition: 'bottom',
      position: 0,
      previousTracks: [],
      progressMs: 0,
      status: STATUS.IDLE,
      track: this.emptyTrack,
      volume: parseVolume(props.initialVolume) || 1,
    };

    this.locale = getLocale(props.locale);

    this.styles = getMergedStyles(props.styles);
  }

  // eslint-disable-next-line react/static-property-placement
  static defaultProps = {
    autoPlay: false,
    initialVolume: 1,
    magnifySliderOnHover: false,
    name: 'Spotify Web Player',
    persistDeviceSelection: false,
    showSaveIcon: false,
    syncExternalDeviceInterval: 5,
    syncExternalDevice: false,
  };

  public async componentDidMount() {
    this.isActive = true;
    const { top = 0 } = this.ref.current?.getBoundingClientRect() || {};

    this.updateState({
      playerPosition: top > window.innerHeight / 2 ? 'bottom' : 'top',
      status: STATUS.INITIALIZING,
    });

    if (!window.onSpotifyWebPlaybackSDKReady) {
      window.onSpotifyWebPlaybackSDKReady = this.initializePlayer;
    } else {
      this.initializePlayer();
    }

    await loadSpotifyPlayer();

    window.addEventListener('resize', this.handleResize);
    this.handleResize();
  }

  public async componentDidUpdate(previousProps: Props, previousState: State) {
    const { currentDeviceId, deviceId, errorType, isInitializing, isPlaying, status, track } =
      this.state;
    const {
      autoPlay,
      layout,
      locale,
      offset,
      play: playProp,
      showSaveIcon,
      styles,
      syncExternalDevice,
      token,
      uris,
    } = this.props;
    const isReady = previousState.status !== STATUS.READY && status === STATUS.READY;
    const changedLayout = !isEqual(previousProps.layout, layout);
    const changedLocale = !isEqual(previousProps.locale, locale);
    const changedStyles = !isEqual(previousProps.styles, styles);
    const changedURIs = !isEqual(previousProps.uris, uris);
    const playOptions = this.getPlayOptions(uris);

    const canPlay = !!currentDeviceId && !!(playOptions.context_uri || playOptions.uris);
    const shouldPlay = (changedURIs && isPlaying) || !!(isReady && (autoPlay || playProp));

    if (canPlay && shouldPlay) {
      await play(token, { deviceId: currentDeviceId, offset, ...playOptions });

      /* istanbul ignore else */
      if (!isPlaying) {
        this.updateState({ isPlaying: true });
      }

      if (this.isExternalPlayer) {
        this.syncTimeout = window.setTimeout(() => {
          this.syncDevice();
        }, 600);
      }
    } else if (changedURIs && !isPlaying) {
      this.updateState({ needsUpdate: true });
    }

    if (previousState.status !== status) {
      this.handleCallback({
        ...this.state,
        type: TYPE.STATUS,
      });
    }

    if (previousState.currentDeviceId !== currentDeviceId && currentDeviceId) {
      if (!isReady) {
        this.handleCallback({
          ...this.state,
          type: TYPE.DEVICE,
        });
      }

      await this.toggleSyncInterval(this.isExternalPlayer);
      await this.updateSeekBar();
    }

    if (previousState.track.id !== track.id && track.id) {
      this.handleCallback({
        ...this.state,
        type: TYPE.TRACK,
      });

      if (showSaveIcon) {
        this.updateState({ isSaved: false });
      }
    }

    if (previousState.isPlaying !== isPlaying) {
      this.toggleProgressBar();
      await this.toggleSyncInterval(this.isExternalPlayer);

      this.handleCallback({
        ...this.state,
        type: TYPE.PLAYER,
      });
    }

    if (token && previousProps.token !== token) {
      if (!isInitializing) {
        this.initializePlayer();
      } else {
        this.hasNewToken = true;
      }
    }

    if (previousProps.play !== playProp && playProp !== isPlaying) {
      await this.togglePlay(!track.id || changedURIs);
    }

    if (previousProps.offset !== offset) {
      await this.toggleOffset();
    }

    if (previousState.isInitializing && !isInitializing) {
      if (syncExternalDevice && !uris) {
        const player: SpotifyPlayerStatus = await getPlaybackState(token);

        /* istanbul ignore else */
        if (player && player.is_playing && player.device.id !== deviceId) {
          this.setExternalDevice(player.device.id);
        }
      }
    }

    if (changedLayout) {
      this.handleResize();
    }

    if (changedLocale) {
      this.locale = getLocale(locale);
    }

    if (changedStyles) {
      this.styles = getMergedStyles(styles);
    }

    if (errorType === 'authentication_error' && this.hasNewToken) {
      this.hasNewToken = false;
      this.initializePlayer();
    }
  }

  public async componentWillUnmount() {
    this.isActive = false;

    /* istanbul ignore else */
    if (this.player) {
      this.player.disconnect();
    }

    clearInterval(this.playerSyncInterval);
    clearInterval(this.playerProgressInterval);
    clearTimeout(this.syncTimeout);

    window.removeEventListener('resize', this.handleResize);
  }

  private handleCallback(state: CallbackState): void {
    const { callback } = this.props;

    if (callback) {
      callback(state);
    }
  }

  private handleChangeRange = async (position: number) => {
    const { track } = this.state;
    const { callback, token } = this.props;
    let progress = 0;

    try {
      const percentage = position / 100;

      if (this.isExternalPlayer) {
        progress = Math.round(track.durationMs * percentage);
        await seek(token, progress);

        this.updateState({
          position,
          progressMs: progress,
        });
      } else if (this.player) {
        const state = await this.player.getCurrentState();

        if (state) {
          progress = Math.round(state.track_window.current_track.duration_ms * percentage);
          await this.player.seek(progress);

          this.updateState({
            position,
            progressMs: progress,
          });
        } else {
          this.updateState({ position: 0 });
        }
      }

      if (callback) {
        callback({
          ...this.state,
          type: TYPE.PROGRESS,
        });
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  private handleClickTogglePlay = async () => {
    const { isActive } = this.state;

    try {
      await this.togglePlay(!this.isExternalPlayer && !isActive);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  private handleClickPrevious = async () => {
    try {
      /* istanbul ignore else */
      if (this.isExternalPlayer) {
        const { token } = this.props;

        await previous(token);
        this.syncTimeout = window.setTimeout(() => {
          this.syncDevice();
        }, 300);
      } else if (this.player) {
        await this.player.previousTrack();
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  private handleClickNext = async () => {
    try {
      /* istanbul ignore else */
      if (this.isExternalPlayer) {
        const { token } = this.props;

        await next(token);
        this.syncTimeout = window.setTimeout(() => {
          this.syncDevice();
        }, 300);
      } else if (this.player) {
        await this.player.nextTrack();
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  private handleClickDevice = async (deviceId: string) => {
    const { isUnsupported } = this.state;
    const { autoPlay, persistDeviceSelection, token } = this.props;

    this.updateState({ currentDeviceId: deviceId });

    try {
      await setDevice(token, deviceId);

      /* istanbul ignore else */
      if (persistDeviceSelection) {
        sessionStorage.setItem('rswpDeviceId', deviceId);
      }

      /* istanbul ignore else */
      if (isUnsupported) {
        await this.syncDevice();

        const player: SpotifyPlayerStatus = await getPlaybackState(token);

        if (player && !player.is_playing && autoPlay) {
          await this.togglePlay(true);
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  private handleFavoriteStatusChange = (status: boolean) => {
    const { isSaved } = this.state;

    this.updateState({ isSaved: status });

    /* istanbul ignore else */
    if (isSaved !== status) {
      this.handleCallback({
        ...this.state,
        isSaved: status,
        type: TYPE.FAVORITE,
      });
    }
  };

  private handlePlayerErrors = async (type: string, message: string) => {
    const { status } = this.state;
    const isPlaybackError = type === 'playback_error';
    const isInitializationError = type === 'initialization_error';
    let nextStatus = status;
    let devices: SpotifyDevice[] = [];

    if (this.player && !isPlaybackError) {
      this.player.disconnect();
      this.player = undefined;
    }

    if (isInitializationError) {
      const { token } = this.props;

      nextStatus = STATUS.UNSUPPORTED;

      ({ devices = [] } = await getDevices(token));
    }

    if (!isInitializationError && !isPlaybackError) {
      nextStatus = STATUS.ERROR;
    }

    this.updateState({
      devices,
      error: message,
      errorType: type,
      isInitializing: false,
      isUnsupported: isInitializationError,
      status: nextStatus,
    });
  };

  private handlePlayerStateChanges = async (state: Spotify.PlaybackState) => {
    try {
      /* istanbul ignore else */
      if (state) {
        const {
          paused,
          position,
          track_window: {
            current_track: { album, artists, duration_ms, id, name, uri },
            next_tracks,
            previous_tracks,
          },
        } = state;

        const isPlaying = !paused;
        const volume = (await this.player?.getVolume()) || 100;
        const track = {
          artists,
          durationMs: duration_ms,
          id,
          name,
          uri,
          ...this.getAlbumImages(album),
        };
        let trackState;

        if (position === 0) {
          trackState = {
            nextTracks: next_tracks,
            position: 0,
            previousTracks: previous_tracks,
            track,
          };
        }

        this.updateState({
          error: '',
          errorType: '',
          isActive: true,
          isPlaying,
          progressMs: position,
          volume: round(volume),
          ...trackState,
        });
      } else if (this.isExternalPlayer) {
        await this.syncDevice();
      } else {
        this.updateState({
          isActive: false,
          isPlaying: false,
          nextTracks: [],
          position: 0,
          previousTracks: [],
          track: {
            artists: '',
            durationMs: 0,
            id: '',
            image: '',
            name: '',
            uri: '',
          },
        });
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  private handlePlayerStatus = async ({ device_id }: Spotify.WebPlaybackInstance) => {
    const { currentDeviceId, devices } = await this.initializeDevices(device_id);

    this.updateState({
      currentDeviceId,
      deviceId: device_id,
      devices,
      isInitializing: false,
      status: device_id ? STATUS.READY : STATUS.IDLE,
    });
  };

  private handleResize = () => {
    const { layout = 'responsive' } = this.props;

    clearTimeout(this.resizeTimeout);

    this.resizeTimeout = window.setTimeout(() => {
      this.renderInlineActions = window.innerWidth >= 768 && layout === 'responsive';
      this.forceUpdate();
    }, 100);
  };

  private handleToggleMagnify = () => {
    const { magnifySliderOnHover } = this.props;

    if (magnifySliderOnHover) {
      this.updateState((previousState: State) => {
        return { isMagnified: !previousState.isMagnified };
      });
    }
  };

  // eslint-disable-next-line class-methods-use-this
  private getAlbumImages = (album: Spotify.Album) => {
    const minWidth = Math.min(...album.images.map(d => d.width || 0));
    const maxWidth = Math.max(...album.images.map(d => d.width || 0));
    const thumb: Spotify.Image =
      album.images.find(d => d.width === minWidth) || ({} as Spotify.Image);
    const image: Spotify.Image =
      album.images.find(d => d.width === maxWidth) || ({} as Spotify.Image);

    return {
      image: image.url,
      thumb: thumb.url,
    };
  };

  private async initializeDevices(id: string) {
    const { persistDeviceSelection, token } = this.props;
    const { devices } = await getDevices(token);
    let currentDeviceId = id;

    if (persistDeviceSelection) {
      const savedDeviceId = sessionStorage.getItem('rswpDeviceId');

      /* istanbul ignore else */
      if (!savedDeviceId || !devices.some((d: SpotifyDevice) => d.id === savedDeviceId)) {
        sessionStorage.setItem('rswpDeviceId', currentDeviceId);
      } else {
        currentDeviceId = savedDeviceId;
      }
    }

    return { currentDeviceId, devices };
  }

  private initializePlayer = () => {
    const { volume } = this.state;
    const { name = 'Spotify Web Player', token } = this.props;

    if (!window.Spotify) {
      return;
    }

    this.updateState({
      error: '',
      errorType: '',
      isInitializing: true,
    });

    this.player = new window.Spotify.Player({
      getOAuthToken: (callback: SpotifyPlayerCallback) => {
        callback(token);
      },
      name,
      volume,
    });

    this.player.addListener('ready', this.handlePlayerStatus);
    this.player.addListener('not_ready', this.handlePlayerStatus);
    this.player.addListener('player_state_changed', this.handlePlayerStateChanges);
    this.player.addListener('initialization_error', error =>
      this.handlePlayerErrors('initialization_error', error.message),
    );
    this.player.addListener('authentication_error', error =>
      this.handlePlayerErrors('authentication_error', error.message),
    );
    this.player.addListener('account_error', error =>
      this.handlePlayerErrors('account_error', error.message),
    );
    this.player.addListener('playback_error', error =>
      this.handlePlayerErrors('playback_error', error.message),
    );

    this.player.connect();
  };

  private get isExternalPlayer(): boolean {
    const { currentDeviceId, deviceId, status } = this.state;

    return (currentDeviceId && currentDeviceId !== deviceId) || status === STATUS.UNSUPPORTED;
  }

  private setExternalDevice = (id: string) => {
    this.updateState({ currentDeviceId: id, isPlaying: true });
  };

  private setVolume = async (volume: number) => {
    const { token } = this.props;

    /* istanbul ignore else */
    if (this.isExternalPlayer) {
      await setVolume(token, Math.round(volume * 100));
      await this.syncDevice();
    } else if (this.player) {
      await this.player.setVolume(volume);
    }

    this.updateState({ volume });
  };

  private syncDevice = async () => {
    if (!this.isActive) {
      return;
    }

    const { deviceId } = this.state;
    const { token } = this.props;

    try {
      const player: SpotifyPlayerStatus = await getPlaybackState(token);
      let track = this.emptyTrack;

      if (!player) {
        throw new Error('No player');
      }

      /* istanbul ignore else */
      if (player.item) {
        track = {
          artists: player.item.artists,
          durationMs: player.item.duration_ms,
          id: player.item.id,
          name: player.item.name,
          uri: player.item.uri,
          ...this.getAlbumImages(player.item.album),
        };
      }

      this.updateState({
        error: '',
        errorType: '',
        isActive: true,
        isPlaying: player.is_playing,
        nextTracks: [],
        previousTracks: [],
        progressMs: player.item ? player.progress_ms : 0,
        status: STATUS.READY,
        track,
        volume: parseVolume(player.device.volume_percent),
      });
    } catch (error: any) {
      const state = {
        isActive: false,
        isPlaying: false,
        position: 0,
        track: this.emptyTrack,
      };

      if (deviceId) {
        this.updateState({
          currentDeviceId: deviceId,
          ...state,
        });

        return;
      }

      this.updateState({
        error: error.message,
        errorType: 'player_status',
        status: STATUS.ERROR,
        ...state,
      });
    }
  };

  private async toggleSyncInterval(shouldSync: boolean) {
    const { syncExternalDeviceInterval } = this.props;

    try {
      if (this.isExternalPlayer && shouldSync && !this.playerSyncInterval) {
        await this.syncDevice();

        clearInterval(this.playerSyncInterval);
        this.playerSyncInterval = window.setInterval(
          this.syncDevice,
          syncExternalDeviceInterval! * 1000,
        );
      }

      if ((!shouldSync || !this.isExternalPlayer) && this.playerSyncInterval) {
        clearInterval(this.playerSyncInterval);
        this.playerSyncInterval = undefined;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  }

  private toggleProgressBar() {
    const { isPlaying } = this.state;

    /* istanbul ignore else */
    if (isPlaying) {
      /* istanbul ignore else */
      if (!this.playerProgressInterval) {
        this.playerProgressInterval = window.setInterval(
          this.updateSeekBar,
          this.seekUpdateInterval,
        );
      }
    } else if (this.playerProgressInterval) {
      clearInterval(this.playerProgressInterval);
      this.playerProgressInterval = undefined;
    }
  }

  private toggleOffset = async () => {
    const { currentDeviceId } = this.state;
    const { offset, token, uris } = this.props;

    if (typeof offset === 'number' && Array.isArray(uris)) {
      await play(token, { deviceId: currentDeviceId, offset, uris });
    }
  };

  private togglePlay = async (init = false) => {
    const { currentDeviceId, isPlaying, needsUpdate } = this.state;
    const { offset, token, uris } = this.props;
    const shouldInitialize = init || needsUpdate;
    const playOptions = this.getPlayOptions(uris);

    try {
      /* istanbul ignore else */
      if (this.isExternalPlayer) {
        if (!isPlaying) {
          await play(token, {
            deviceId: currentDeviceId,
            offset,
            ...(shouldInitialize ? playOptions : undefined),
          });
        } else {
          await pause(token);

          this.updateState({ isPlaying: false });
        }

        this.syncTimeout = window.setTimeout(() => {
          this.syncDevice();
        }, 300);
      } else if (this.player) {
        const playerState = await this.player.getCurrentState();

        await this.player.activateElement();

        // eslint-disable-next-line unicorn/prefer-ternary
        if (
          (!playerState && !!(playOptions.context_uri || playOptions.uris)) ||
          (shouldInitialize && playerState && playerState.paused)
        ) {
          await play(token, {
            deviceId: currentDeviceId,
            offset,
            ...(shouldInitialize ? playOptions : undefined),
          });
        } else {
          await this.player.togglePlay();
        }
      }

      if (needsUpdate) {
        this.updateState({ needsUpdate: false });
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  private updateSeekBar = async () => {
    if (!this.isActive) {
      return;
    }

    const { progressMs, track } = this.state;

    try {
      /* istanbul ignore else */
      if (this.isExternalPlayer) {
        let position = progressMs / track.durationMs;

        position = Number(((Number.isFinite(position) ? position : 0) * 100).toFixed(1));

        this.updateState({
          position,
          progressMs: progressMs + this.seekUpdateInterval,
        });
      } else if (this.player) {
        const state = await this.player.getCurrentState();

        /* istanbul ignore else */
        if (state) {
          const progress = state.position;
          const position = Number(
            ((progress / state.track_window.current_track.duration_ms) * 100).toFixed(1),
          );

          this.updateState({
            position,
            progressMs: progress + this.seekUpdateInterval,
          });
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  private updateState = (state = {}) => {
    if (!this.isActive) {
      return;
    }

    this.setState(state);
  };

  public render() {
    const {
      currentDeviceId,
      deviceId,
      devices,
      error,
      errorType,
      isActive,
      isMagnified,
      isPlaying,
      isUnsupported,
      nextTracks,
      playerPosition,
      position,
      previousTracks,
      progressMs,
      status,
      track,
      volume,
    } = this.state;
    const {
      hideAttribution = false,
      inlineVolume = true,
      layout = 'responsive',
      name,
      showSaveIcon,
      token,
      updateSavedStatus,
    } = this.props;
    const isReady = ([STATUS.READY, STATUS.UNSUPPORTED] as Status[]).indexOf(status) >= 0;
    const isPlaybackError = errorType === 'playback_error';

    const output: Record<string, ReactNode> = {
      main: <Loader styles={this.styles} />,
    };

    if (isPlaybackError) {
      output.info = <p>{error}</p>;
    }

    if (isReady) {
      /* istanbul ignore else */
      if (!output.info) {
        output.info = (
          <Info
            hideAttribution={hideAttribution}
            isActive={isActive}
            layout={layout}
            locale={this.locale}
            onFavoriteStatusChange={this.handleFavoriteStatusChange}
            showSaveIcon={showSaveIcon!}
            styles={this.styles}
            token={token}
            track={track}
            updateSavedStatus={updateSavedStatus}
          />
        );
      }

      output.devices = (
        <Devices
          currentDeviceId={currentDeviceId}
          deviceId={deviceId}
          devices={devices}
          layout={layout}
          locale={this.locale}
          onClickDevice={this.handleClickDevice}
          open={isUnsupported && !deviceId}
          playerPosition={playerPosition}
          styles={this.styles}
        />
      );

      output.volume = currentDeviceId ? (
        <Volume
          inlineVolume={inlineVolume}
          layout={layout}
          locale={this.locale}
          playerPosition={playerPosition}
          setVolume={this.setVolume}
          styles={this.styles}
          volume={volume}
        />
      ) : null;

      if (this.renderInlineActions) {
        output.actions = (
          <Actions layout={layout} styles={this.styles}>
            {output.devices}
            {output.volume}
          </Actions>
        );
      }

      output.controls = (
        <Controls
          devices={this.renderInlineActions ? null : output.devices}
          durationMs={track.durationMs}
          isExternalDevice={this.isExternalPlayer}
          isMagnified={isMagnified}
          isPlaying={isPlaying}
          layout={layout}
          locale={this.locale}
          nextTracks={nextTracks}
          onChangeRange={this.handleChangeRange}
          onClickNext={this.handleClickNext}
          onClickPrevious={this.handleClickPrevious}
          onClickTogglePlay={this.handleClickTogglePlay}
          onToggleMagnify={this.handleToggleMagnify}
          position={position}
          previousTracks={previousTracks}
          progressMs={progressMs}
          styles={this.styles}
          volume={this.renderInlineActions ? null : output.volume}
        />
      );

      output.main = (
        <>
          {output.info}
          {output.controls}
          {output.actions}
        </>
      );
    } else if (output.info) {
      output.main = output.info;
    }

    if (status === STATUS.ERROR) {
      output.main = (
        <ErrorMessage styles={this.styles}>
          {name}: {error}
        </ErrorMessage>
      );
    }

    return (
      <Player ref={this.ref} data-ready={isReady} styles={this.styles}>
        <Wrapper layout={layout} styles={this.styles}>
          {output.main}
        </Wrapper>
      </Player>
    );
  }
}

export * from './types';

export default SpotifyWebPlayer;

export { TYPE } from './constants';
export { STATUS } from './constants';
