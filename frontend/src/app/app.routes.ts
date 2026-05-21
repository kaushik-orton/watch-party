import { Routes } from '@angular/router';
import { LobbyComponent } from './components/lobby/lobby';
import { TheaterComponent } from './components/theater/theater';

export const routes: Routes = [
  { path: '', component: LobbyComponent },
  { path: 'room/:id', component: TheaterComponent },
  { path: '**', redirectTo: '' }
];
