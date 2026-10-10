# Plan d'implémentation — Fonctionnalités NAS manquantes pour umbrelOS

> Document de planification uniquement. Toutes les références de fichiers pointent vers l'état actuel de `master` (umbrelOS 2.0).

---

## 1. Contexte et objectifs

### 1.1 Constat

umbrelOS est aujourd'hui un excellent home server « cloud personnel », mais il lui manque les briques bas niveau qui définissent un NAS au sens strict : partage multi-protocoles, intégrité/chiffrement du stockage, fiabilité alimentaire et surveillance matérielle.

### 1.2 Objectif du plan

Transformer umbrelOS en NAS crédible, **sans casser** son positionnement (simplicité, apps, sauvegardes), en comblant les manques identifiés par ordre de criticité.

### 1.3 Principes directeurs

- **Tout passe par les surfaces produit** : modules umbreld → routes tRPC → UI Settings. Pas de hack hors architecture.
- **Pérennité** : chaque fonctionnalité livrée avec migration de démarrage (`modules/startup-migrations/`) et tests VM (`*.vm.test.ts`).
- **Sécurité par défaut** : pas de secret codé en dur, pas d'exposition anonyme non consentie.
- **Isolation des risques** : les features dangereuses (chiffrement, iSCSI, NFS) sont opt-in et testées en VM avec vrai matériel simulé.

---

## 2. Architecture d'intégration (commune à toutes les features)

Chaque nouvelle fonctionnalité suit le même squelette, calqué sur l'existant :

| Couche | Emplacement | Rôle |
|---|---|---|
| Module umbreld | `packages/umbreld/source/modules/<domaine>/<feature>.ts` | Logique, accès système, état |
| Enregistrement | `packages/umbreld/source/index.ts` | Instanciation + cycle de vie `start()`/`stop()` |
| Routes API | `modules/<domaine>/routes.ts` (tRPC) | Surface publique authentifiée |
| Persistance | `this.#umbreld.store.getWriteLock()` | Config durable, versionnée |
| Migration | `modules/startup-migrations/index.ts` | Compat ascendante |
| UI | `packages/ui/src/routes/settings/` + `features/<domaine>/` | Pages et hooks |
| i18n | fichiers de traduction | FR/EN et locales existantes |
| Tests | `*.unit.test.ts`, `*.integration.test.ts`, `*.vm.test.ts` | Couverture par niveaux |

**Convention de tests VM** (cf. `.agents/skills/umbreld-vm-test-authoring/SKILL.md`) : utiliser `createTestVm`, tester le comportement OS réel (reboot, attache de disques, réseau), préférer les surfaces produit (tRPC, files API).

---

## 3. Phase 1 — Critiques (fondations NAS)

### 3.1 Serveur NFS

**Objectif** : partager des dossiers vers Linux/Proxmox/ESXi/macOS en NFSv4.

**Approche technique**
- Module `modules/files/nfs.ts`, symétrique de `samba.ts`.
- Dépendance système : `nfs-kernel-server` à ajouter dans `packages/os/umbrelos.Dockerfile` (section apt à la ligne ~421).
- Export via `/etc/exports.d/umbrel.exports` généré, avec `exportfs -ra` à l'application.
- Modèle de partage : réutiliser `files.shares` mais avec un champ `protocols: ('smb' | 'nfs')[]`, ou une table `files.nfsExports` séparée.
- Sécurité : NFSv4 uniquement, `sec=krb5` non requis en v1 ; restreindre par sous-réseau LAN, `root_squash` par défaut, `no_subtree_check`.
- Permissions : mapper les UID/GID des membres vers les comptes Unix gérés (le module `samba.ts` crée déjà des users système — factoriser dans un helper partagé `modules/files/system-users.ts`).

**Fichiers concernés**
- Nouveau : `modules/files/nfs.ts`, `modules/files/nfs.unit.test.ts`, `modules/files/nfs.vm.test.ts`
- Modifiés : `modules/files/files.ts` (start/stop), `modules/files/routes.ts` (routes), `index.ts`, `packages/os/umbrelos.Dockerfile`
- UI : `routes/settings/file-sharing.tsx` (onglet/selecteur de protocole), `features/files/hooks/use-shares.ts`

**Étapes**
1. Extraire la gestion des comptes Unix dans un module partagé.
2. Implémenter `Nfs` : `start`, `stop`, `applyExports`, `listExports`, `addExport`, `removeExport`.
3. Route tRPC `files.nfs.*` (privée, owner + membres selon partage).
4. UI : activer NFS par partage + instructions client (Linux/Proxmox).
5. Tests VM : montage réel depuis une VM cliente, vérification permissions lecture/écriture par membre, persistance après reboot.

**Risques** : collisions d'UID entre comptes apps et membres ; à traiter via une plage UID dédiée.

---

### 3.2 Serveur WebDAV

**Objectif** : accès fichiers depuis Windows/macOS/Linux sans client SMB, et compat apps mobiles.

**Approche technique**
- Option A (recommandée) : serveur WebDAV basé sur `rclone serve webdav` — rclone est déjà intégré (module `cloud.ts`), cohérence des dépendances.
- Option B : `apache2`/`nginx` + `dav_ext` — plus lourd, à éviter.
- Authentification : réutiliser les credentials des membres (mêmes comptes que Samba), token par membre.
- Exposition réseau : via `lan-ingress` existant + TLS natif (`modules/lan-ingress/native-tls.ts`).

**Fichiers concernés**
- Nouveau : `modules/files/webdav.ts`, tests unit + VM
- Modifiés : `modules/files/files.ts`, `routes.ts`, `index.ts`
- UI : même page file-sharing, section WebDAV + URL/identifiants

**Étapes**
1. Démarrer un process `rclone serve webdav` par membre activé, sur port loopback.
2. Reverse-proxy via `lan-ingress` avec auth.
3. Routes tRPC d'activation et d'affichage des identifiants.
4. Tests : accès authentifié/non-authentifié, isolation entre membres.

---

### 3.3 Chiffrement de disque réel (LUKS)

**Objectif** : remplacer le mot de passe codé en dur actuel par un vrai chiffrement à la passphrase utilisateur.

**État actuel (preuve)** : `modules/hardware/raid.ts:40` → `const defaultEncryptionPassword = 'umbrelumbrel'` ; commentaire `raid.ts:1464` : *« This obviously doesn't provide any security »* ; le pool ZFS est créé avec `keyformat=passphrase` et cette valeur (`raid.ts:1480`).

**Approche technique**
- Chiffrement au niveau bloc via **LUKS2** (`cryptsetup`), sous ZFS, ou chiffrement natif ZFS avec passphrase utilisateur (plus simple, ZFS déjà présent).
- **Recommandé** : ZFS natif — le pool est déjà créé avec `encryption=aes-256-gcm` + `keyformat=passphrase`. Il suffit de remplacer la constante par une passphrase fournie par l'utilisateur.
- Stockage du keyfile : `keylocation=file:///...` dans un volume chiffré, déverrouillé au boot par passphrase, ou saisie interactive au boot via console (`overlay/opt/umbrel-tty-message` existe déjà).
- Gestion du cycle : déverrouillage au démarrage, `zfs load-key`, verrouillage à l'arrêt, changement de passphrase (`zfs change-key`).

**Fichiers concernés**
- Modifiés : `modules/hardware/raid.ts` (création de pool, `load-key`, `change-key`), `modules/hardware/routes.ts`
- Nouveau : `modules/hardware/encryption.ts` + tests
- UI : `features/storage/` (assistant de création de pool avec saisie passphrase), `routes/onboarding/raid/`
- OS : dépendance `cryptsetup` si LUKS retenu

**Étapes**
1. Étendre l'assistant de création de pool pour demander une passphrase.
2. Remplacer `defaultEncryptionPassword` par la passphrase utilisateur (jamais loggée).
3. Implémenter déverrouillage/verrouillage + changement de passphrase.
4. Migration : pour les pools existants chiffrés avec le mot de passe par défaut, proposer une ré-encryption via `zfs change-key`.
5. Tests VM : reboot avec pool chiffré, mauvais mot de passe, changement de passphrase, données lisibles après déverrouillage.

**Risques majeurs** : perte de passphrase = perte de données. Prévoir avertissements explicites et phrase de récupération. Tester le chemin de récupération en VM.

---

### 3.4 Notifications d'échec disque + self-tests SMART

**Objectif** : alerter avant la panne, pas après.

**État actuel (preuve)** : `modules/hardware/internal-storage.ts:62-88` ne lit que santé, température, `percentage_used` NVMe. Aucune notification SMART dans `modules/notifications/`.

**Approche technique**
- Étendre `getSmartData` : attributs critiques (Reallocated_Sector_Ct, Current_Pending_Sector, Offline_Uncorrectable, Power_On_Hours), via `smartctl --json`.
- Surveillance périodique (déjà le pattern du scheduler scrub dans `raid.ts:614`) : tick quotidien.
- Notifications : ajouter `disk-health-warning:<deviceId>` et `disk-temperature:<deviceId>` au système existant (`notifications.add(...)`).
- Self-tests : `smartctl -t short` / `-t long`, planifiés (mensuel) et à la demande.

**Fichiers concernés**
- Modifiés : `modules/hardware/internal-storage.ts`, `modules/hardware/routes.ts`, `modules/notifications/notifications.ts`
- UI : `routes/notifications.tsx` (rendu des nouvelles notifs), `features/storage/components/ssd-card.tsx`
- Tests : unit pour le parsing SMART, VM pour le déclenchement de notification

**Étapes**
1. Étendre le parsing SMART + seuils configurables.
2. Scheduler de surveillance + déduplication des notifs.
3. Boutons « test court » / « test long » dans Storage Manager.
4. Rendu UI des alertes avec action « voir le disque ».

---

## 4. Phase 2 — Importants (parité NAS)

### 4.1 Améliorations des partages SMB

**État actuel (preuves)** : `writeable = yes` codé en dur (`samba.ts:77`) ; `map to guest = never` + `restrict anonymous = 2` (`samba.ts:51-53`) ; `force user = root` / `force group = umbrel` (`samba.ts:87-89`) ; API `addShare` n'accepte que `path` (`routes.ts:402-404`).

**Travaux**
- **Partage lecture seule** : champ `readOnly` dans le modèle de partage → `writeable = no` conditionnel.
- **Accès invité** (opt-in, désactivé par défaut) : `map to guest = bad user` + partage `guest ok = yes` uniquement sur les partages explicitement publics.
- **Corbeille** : activer `vfs objects = recycle` avec `recycle:repository = .recycle` sur les partages concernés.
- **Config protocole** : exposer `server min protocol` / `client min protocol` (SMB2/3), `server multi channel support`.
- **Nom de partage personnalisé** et options par partage.
- **Réconciliation des credentials** : conserver la logique robuste existante (`samba.ts:274-374`) mais factoriser pour NFS/WebDAV.

**Fichiers concernés** : `modules/files/samba.ts`, `modules/files/routes.ts`, `features/files/hooks/use-shares.ts`, `routes/settings/file-sharing.tsx`, tests `samba.unit.test.ts`, `samba-multi-user.vm.test.ts`.

---

### 4.2 Groupes et ACL

**Objectif** : permissions fines au-delà du « un partage = un compte ».

**Approche technique**
- Introduction de groupes POSIX gérés par umbreld (`groupadd`/`usermod -aG`), persistance dans le store.
- ACL POSIX exposées : `setfacl`/`getfacl` (ZFS est déjà monté avec `acltype=posixacl`, `raid.ts:1481`).
- UI : matrice utilisateurs × partages avec droits lecture/écriture/administration.

**Fichiers concernés** : nouveau `modules/user/groups.ts`, `modules/files/permissions.ts` ; UI `routes/settings/users.tsx`, `features/files/`.

**Tests VM** : vérifier l'accès effectif par membre après changement de groupe/ACL, y compris via NFS et SMB.

---

### 4.3 Quotas

**Objectif** : limiter l'espace par utilisateur/partage.

**Approche technique** : quotas ZFS natifs (`zfs set quota=` / `userquota@`) sur datasets par membre. ZFS déjà en place → pas de dépendance supplémentaire.
- Routes tRPC : `storage.setQuota`, `storage.getQuotas`.
- UI : champ quota dans la fiche utilisateur et dans Storage Manager.

**Tests** : écriture au-delà du quota → `ENOSPC`, vérification par membre.

---

### 4.4 Support UPS / NUT

**Objectif** : arrêt propre sur batterie faible, alerte de coupure.

**État actuel (preuve)** : aucun `nut`/`upsmon`/`upsc` dans umbreld ; non installé dans `packages/os/umbrelos.Dockerfile:421`.

**Approche technique**
- Ajouter `nut-server` + `nut-client` à l'image OS.
- Module `modules/hardware/ups.ts` : détection USB (udev déjà utilisé dans `packages/os/overlay/etc/udev/`), configuration `ups.conf`/`upsd`/`upsmon`, seuils.
- Découverte automatique : `nut-scanner` au branchement USB.
- Notifications : `ups-on-battery`, `ups-low-battery`, `ups-restored`.
- Action : arrêt propre automatique sous seuil (déclenche le shutdown existant).

**Fichiers concernés** : nouveau `modules/hardware/ups.ts` + tests VM (simulation via driver NUT `dummy-ups`), `packages/os/umbrelos.Dockerfile`, UI dans Storage/Advanced settings, `routes/notifications.tsx`.

---

### 4.5 Gestion d'énergie des disques

**Objectif** : spin-down des HDD, Wake-on-LAN.

**État actuel (preuve)** : aucun `hdparm`/`hd-idle`/`spindown`/`wol` dans le code.

**Approche technique**
- Spin-down : `hdparm -S` ou démon `hd-idle`, configurable par disque (délai d'inactivité).
- Wake-on-LAN : `ethtool -s <iface> wol g`, réveil programmé, bouton « réveiller » dans l'UI.
- Attention : ne jamais spin-down un disque hébergeant le pool ZFS actif ; exclure les disques système/pool.
- Notifications : erreurs SMART liées au spin-up (Count of spin-up) déjà couvertes par 3.4.

**Fichiers concernés** : nouveau `modules/hardware/power.ts` + tests, UI Storage Manager par disque, `packages/os/overlay/etc/systemd/` pour le service.

---

## 5. Phase 3 — Confort et compléments

### 5.1 Time Machine dédié

- Créer automatiquement un partage « Time Machine » dédié (plutôt que `fruit:time machine = yes` sur tous les partages, `samba.ts:92`).
- Quota de taille et rétention configurables.
- UI : section dédiée avec instructions macOS.

### 5.2 Snapshots ZFS exposés à l'utilisateur

- Aujourd'hui les snapshots sont internes (backups/VMs, `modules/backups/backups.ts`). Exposer la création/liste/restauration de snapshots ZFS par dataset via l'UI « Rewind » existante (`features/files/hooks/use-rewind.ts`) ou une vue dédiée.
- Politique de snapshots planifiés (horaire/journalier) avec rétention.

### 5.3 Cible iSCSI

- Module `modules/hardware/iscsi.ts` basé sur `tgt` ou `targetcli`.
- Création de LUN (zvol ZFS), contrôle d'accès par initiateur IQN, CHAP.
- UI dans Storage Manager. Tests VM : connexion depuis une VM cliente, boot, persistance.

### 5.4 FTP / SFTP serveur

- SFTP : exposer via `sshd` (OpenSSH) avec chroot par utilisateur — plus simple et sécurisé que FTP.
- FTP : optionnel via `vsftpd`, à ne proposer que si demande réelle (moins prioritaire que NFS/WebDAV).

### 5.5 VPN serveur natif

- Actuellement Tailscale est une *app* (`modules/system/tailscale.ts`), pas une feature native. Pas de WireGuard/OpenVPN natif.
- Option : intégration native WireGuard (génération de clés, config client, QR code) pour un accès distant sans dépendre d'une app tierce.
- Décision à prendre : garder Tailscale comme app vs. natif. Recommandation : garder app, documenter, ne pas dupliquer.

### 5.6 Synchro native (Syncthing / rsync)

- Pas de `rsyncd` serveur dans le code ; Syncthing est une app.
- Option : exposer un endpoint `rsync` en lecture seule pour sauvegardes pull, ou s'appuyer sur Syncthing (app) et documenter.
- Recommandation : ne pas réimplémenter Syncthing ; ajouter `rsyncd` optionnel si besoin de scripts tiers.

---

## 6. Exigences transverses

### 6.1 Migrations

Chaque feature ajoute une entrée dans `modules/startup-migrations/index.ts` :
- Schéma de config versionné.
- Valeurs par défaut sûres (aucune feature réseau activée sans consentement).
- Compat avec installations existantes (pool chiffré au mot de passe par défaut, partages SMB actuels).

### 6.2 Sécurité

- Jamais de secret en dur (remplace `umbrelumbrel`).
- Toute nouvelle surface réseau : opt-in, limitée au LAN par défaut, TLS natif.
- Auth cohérente : réutiliser `privateProcedure` / `privateProcedureWithMembers` (`routes.ts`).
- Audit : ne pas logger passphrases/clés.

### 6.3 Tests

- **Unit** : parsing (SMART, exports NFS, config Samba), logique de seuils.
- **Integration** : modules avec `umbreld.instance`.
- **VM** : reboot, attache de disques, montages réels, isolation multi-utilisateurs, chiffrement, UPS simulé (`dummy-ups`).
- Étendre le harness `modules/test-utilities/create-test-umbreld.ts` si besoin de primitives (ex. attacher un UPS USB simulé).

### 6.4 UI / i18n

- Nouvelles pages dans `routes/settings/` + entrées dans `routes/settings/_components/settings-catalog.ts`.
- Hooks dans `features/<domaine>/hooks/`.
- Traductions pour toutes les locales existantes.
- Réutiliser les patterns existants (drawer/dialog mobile, `settings-content.tsx`).

### 6.5 Documentation

- Mise à jour `README.md` (fonctionnalités, prérequis matériels).
- Guides par feature (NFS, UPS, chiffrement) côté docs produit.

---

## 7. Feuille de route recommandée

| Phase | Features | Dépendances | Risque |
|---|---|---|---|
| **1 — Critiques** | NFS, WebDAV, chiffrement LUKS/ZFS, notifs SMART + self-tests | `nfs-kernel-server`, factorisation comptes Unix | Élevé (chiffrement) |
| **2 — Importants** | SMB (RO/guest/corbeille/protocole), groupes/ACL, quotas, UPS/NUT, spin-down/WoL | Phase 1 (factorisation) | Moyen |
| **3 — Confort** | Time Machine dédié, snapshots ZFS UI, iSCSI, SFTP, VPN natif, rsync | Phase 2 | Moyen |

### Ordre d'implémentation conseillé (atomique, un commit = un changement)

1. Factoriser la gestion des comptes Unix partagés (`modules/files/system-users.ts`).
2. Notifications SMART + self-tests (faible risque, forte valeur, valide le pipeline notifs).
3. SMB : lecture seule + corbeille + nom de partage (petits changements à fort impact).
4. Chiffrement de pool (LUKS/ZFS passphrase) + migration.
5. NFS serveur.
6. WebDAV serveur.
7. Groupes/ACL + quotas.
8. UPS/NUT + spin-down/WoL.
9. Phase 3 au fil des demandes.

---

## 8. Risques et points d'attention

| Risque | Impact | Mitigation |
|---|---|---|
| Perte de passphrase de chiffrement | Perte totale de données | Avertissements, phrase de récupération, test du chemin de récupération en VM |
| Collisions UID/GID (apps vs membres) | Corruptions de permissions | Plage UID dédiée, tests VM multi-utilisateurs |
| Spin-down d'un disque ZFS actif | Corruption / lenteurs | Exclure disques système/pool, liste blanche explicite |
| NFS mal configuré | Exposition réseau | NFSv4, restriction sous-réseau, `root_squash`, opt-in |
| Complexité iSCSI/ACL | Surface de bug | Livrer après Phase 2, tests VM dédiés |
| Dérive du support Tailscale (app vs natif) | Duplication | Décision produit : garder app, ne pas dupliquer |

---

## 9. Définition de « terminé » (par feature)

- [ ] Module umbreld avec `start`/`stop` propres et gestion d'erreurs.
- [ ] Routes tRPC privées et testées (authentifié + non authentifié).
- [ ] UI complète (desktop + mobile) + i18n.
- [ ] Migration de démarrage si état persistant.
- [ ] Tests unit + intégration + VM (reboot, permissions, isolation).
- [ ] Documentation utilisateur.
- [ ] Feature opt-in, valeurs par défaut sûres, aucun secret en dur.

---

*Fin du plan.*
