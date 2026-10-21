# GAINAKO

Application cartographique de suivi des champs et d’aide à la décision agricole.

## Confidentialité

GAINAKO utilise une connexion Supabase. Le code source peut rester dans un dépôt GitHub privé ; GitHub Pro autorise Pages depuis un dépôt privé, mais l’adresse Pages et l’interface du site sont publiques. Les coordonnées, contours et observations sont chargés depuis Supabase uniquement après connexion.

La sécurité des données dépend des règles RLS du fichier `supabase/schema.sql` et des adhésions dans `field_members`. N’ajoutez jamais de coordonnées privées au HTML, au JavaScript ou à la configuration du site. La clé Publishable de Supabase est destinée à être utilisée dans le navigateur ; ne mettez jamais une clé `service_role` ou une clé secrète dans le site.

Après connexion, les demandes de tuiles transmettent la zone consultée aux fournisseurs cartographiques (notamment Esri), qui reçoivent aussi les informations réseau nécessaires pour servir ces images. L’analyse NDVI envoie le contour autorisé de la parcelle et la période d’étude à Copernicus via la fonction Supabase `sentinel-analysis` ; le secret OAuth n’est jamais transmis au navigateur.

## Mise en service

1. Créez un projet Supabase Free, puis exécutez `supabase/schema.sql` dans son SQL Editor.
2. Dans Authentication > Users, créez les comptes autorisés. GAINAKO ne propose pas d’inscription publique.
3. Dans la table `fields`, ajoutez la parcelle : son nom, son centre et son contour sous forme de tableau JSON `[[latitude, longitude], ...]`. Gardez ces données dans Supabase, pas dans les fichiers du dépôt. La colonne `boundary` attend un tableau de points ; chaque point est `[latitude, longitude]`.
4. Vérifiez que les adresses des comptes sont confirmées. Dans le SQL Editor, récupérez l’identifiant de la parcelle dans `public.fields` et les UUID des comptes dans `auth.users`, puis ajoutez-les à `field_members` en remplaçant les valeurs ci-dessous :

   ```sql
   insert into public.field_members (field_id, user_id)
   select 'UUID_DE_LA_PARCELLE'::uuid, users.id
   from auth.users as users
   where users.email in ('EMAIL_AUTORISE_1', 'EMAIL_AUTORISE_2');
   ```

   Sans cette adhésion, un compte ne peut pas lire la parcelle.
5. Dans `supabase-config.js`, renseignez l’URL du projet et sa clé Publishable depuis les paramètres/API Keys Supabase. Cette configuration est visible dans le navigateur ; les politiques RLS doivent rester activées.
6. Créez un client OAuth Copernicus Data Space depuis [les paramètres du compte](https://shapps.dataspace.copernicus.eu/dashboard/#/account/settings), puis stockez `COPERNICUS_CLIENT_ID` et `COPERNICUS_CLIENT_SECRET` dans **Edge Functions > Secrets** du projet Supabase. Ne mettez jamais ces valeurs dans les fichiers du site.
7. Depuis le dossier du projet, déployez l’analyse avec `supabase functions deploy sentinel-analysis --project-ref VOTRE_PROJECT_REF`. La vérification JWT doit rester activée ; la fonction vérifie aussi la session et lit le contour avec les règles RLS de l’utilisateur.
8. Activez GitHub Pages dans les paramètres du dépôt, depuis la branche `main` et le dossier racine. Le dépôt source peut rester privé avec GitHub Pro ; le site publié, lui, est public. Les visiteurs non connectés ne reçoivent pas les données de la parcelle.

Les observations et modifications du contour sont synchronisées dans Supabase entre les appareils. L’export et l’import JSON restent disponibles pour faire une copie ou transférer d’anciennes observations. L’import ajoute ou met à jour les observations correspondantes et remplace le contour ; il ne supprime pas les autres observations déjà présentes.

## Offre gratuite et limites

GitHub Pages sert les fichiers statiques sans facturation à l’usage de l’application. Supabase Free inclut l’authentification et une base de données à 0 $, dans les limites du plan. Les projets gratuits peuvent être mis en pause après une semaine d’inactivité ; les quotas et conditions des fournisseurs peuvent évoluer. Une connexion Internet est requise pour se connecter, synchroniser les données et charger les cartes.

Le panneau Couches cartographiques permet de choisir Esri Wayback, Sentinel‑2 Copernicus ou OpenStreetMap comme fond, et d’afficher séparément le NDVI et le contour. L’image Copernicus en couleurs naturelles et le NDVI sont préparés par l’analyse pour la période choisie ; la couche NDVI et le contour peuvent être cochés indépendamment. L’image Sentinel‑2 est centrée sur le champ avec au moins environ 500 m de marge autour ; elle couvre une zone locale et ne remplace pas un fond mondial lors d’un zoom arrière. Le curseur Esri Wayback sélectionne une version archivée du fond satellite ; la date affichée est celle de la version, pas nécessairement la date de prise de vue à cet endroit. Quand Esri fournit les métadonnées, la date de la prise de vue est indiquée séparément. Changer de version conserve le cadrage et le zoom de la carte.

L’analyse NDVI est lancée à la demande pour une date précise ou une période choisie, limitée à un an. Pour analyser une date seule, indique le même jour comme début et fin. Elle résume les observations Sentinel‑2 L2A disponibles sur cette période, en filtrant les nuages et les ombres, puis affiche une couche NDVI colorée et une interprétation indicative. La légende va du brun (signal faible) au vert (signal de végétation plus élevé) ; les zones transparentes correspondent aux nuages, ombres ou données absentes. La résolution native est d’environ 10 m : l’image colorée n’ajoute pas de détail en zoomant. NDVI inférieur à 0,2, de 0,2 à 0,4 et supérieur ou égal à 0,4 sont des classes indicatives, non des diagnostics agronomiques universels. L’indice ne mesure pas la fertilité ni la santé de la culture ; saison, récolte, eau, stress et pixels mixtes influencent le résultat. Sur une parcelle de 2,6 ha, le nombre de pixels exploitables est limité : vérifier les observations sur le terrain. L’API Copernicus Data Space a des quotas et peut ne pas fournir d’image exploitable en cas de nuages ou de manque d’observations. La PWA met en cache la coquille du site, pas la carte ni les données privées. La surface affichée est calculée à partir du contour enregistré, pas une mesure cadastrale.
