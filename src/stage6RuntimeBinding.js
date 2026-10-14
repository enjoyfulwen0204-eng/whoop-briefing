// Brands can only be issued by the owned constructors in db.js.
import {stage6OwnedBinding,isOwnedStage6Memory} from './db.js';
export const stage6RuntimeBinding=db=>stage6OwnedBinding(db);
export const isStage6Memory=db=>isOwnedStage6Memory(db);
