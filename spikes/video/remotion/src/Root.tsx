import {Composition} from 'remotion';
import {MyComposition} from './Composition';
import settings from '../settings.json';
export const RemotionRoot=()=> <Composition id="Portfolio" component={MyComposition} durationInFrames={Math.round((settings.intro+12.3-settings.outroAdvance+2)*30)} fps={30} width={1920} height={1080}/>;
